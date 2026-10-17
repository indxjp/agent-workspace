/* global Buffer, process */ // The root ESLint config declares no environment globals.
// The smallest MCP server a gallery use case needs: newline-delimited JSON-RPC over stdio,
// `initialize`, `tools/list` and `tools/call`, with no dependency. Agent Workspace registers it as
// a `stdio` connector (`command: node`, `args: [<server>.mjs]`) and the run's engine spawns it.
//
// It is deliberately hand-written, as `apps/web/server/connectors/fixtures/stdio-server.mjs` is:
// the gallery shows what the platform needs from your server, and a reader can see all of it here.
// A production server would use the reference MCP SDK; nothing about the platform changes.
//
// Two transports, chosen by environment: stdio by default, or Streamable HTTP when
// `MCP_TRANSPORT=http` (listening on `PORT`, default 8787, path `/mcp`). A project file
// (`agent-workspace.yaml`) may declare only remote `http`/`sse` connectors, so the HTTP form is
// the one `aw dev` can keep in step; a `stdio` connector is created through the SDK
// (`aw.connectors.create({ transport: 'stdio', command, args })`) and runs inside the runtime.
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2025-11-25';

/**
 * Serve `tools` over stdio until stdin closes, or over Streamable HTTP when `MCP_TRANSPORT=http`.
 *
 * Each tool is `{ name, description, inputSchema, handler }`. `handler(args)` returns a plain
 * value: a string is sent as text, anything else as pretty JSON text, which is what the agent
 * reads. A handler that throws becomes a tool result with `isError: true`, never a crash, so one
 * bad call cannot end the agent's run.
 */
export function serveTools({ name, version = '0.1.0', tools }) {
  const handle = createHandler({ name, version, tools });
  if (process.env.MCP_TRANSPORT === 'http') return serveHttp(handle);
  const rl = createInterface({ input: process.stdin });
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  rl.on('line', (line) => {
    if (line.trim() === '') return;
    const message = parse(line);
    if (message === undefined) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    void handle(message).then((reply) => {
      if (reply !== undefined) send(reply);
    });
  });
  return undefined;
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Streamable HTTP, JSON responses only: one POST carries one JSON-RPC message. */
function serveHttp(handle) {
  const port = Number(process.env.PORT ?? 8787);
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const message = parse(Buffer.concat(chunks).toString('utf8'));
      if (message === undefined) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          }),
        );
        return;
      }
      void handle(message).then((reply) => {
        if (reply === undefined) {
          response.writeHead(202).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(reply));
      });
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

/** The JSON-RPC dispatcher both transports share. */
export function createHandler({ name, version = '0.1.0', tools }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return async function handle(message) {
    const { id, method, params } = message;
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name, version },
        },
      };
    }
    if (method === 'notifications/initialized') return undefined;
    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: tools.map(({ name: toolName, description, inputSchema }) => ({
            name: toolName,
            description,
            inputSchema,
          })),
        },
      };
    }
    if (method === 'tools/call') {
      const tool = byName.get(params?.name);
      if (tool === undefined) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Unknown tool ${params?.name}` },
        };
      }
      try {
        const value = await tool.handler(params.arguments ?? {});
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text }], isError: false },
        };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
      }
    }
    if (id === undefined) return undefined;
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  };
}

/** Throw an error the agent reads as the tool's answer (see `serveTools`). */
export function refuse(message) {
  throw new Error(message);
}

/** A required, non-blank string argument, or a refusal naming it. */
export function text(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') refuse(`${key} must be a non-empty string`);
  return value.trim();
}

/** An optional positive integer argument, clamped to `max`. */
export function limit(args, key, fallback, max) {
  const value = args[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) refuse(`${key} must be a positive integer`);
  return Math.min(value, max);
}
