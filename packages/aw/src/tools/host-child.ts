/**
 * The tool host child (issue #693, D48): imports the project's code tools and serves them over
 * MCP Streamable HTTP on `127.0.0.1:<port>/<token>/mcp`. It is the project's own code, run as
 * `node tools/x.ts` would run it: full Node, the project's `node_modules`, the developer's
 * environment. Uses only erasable syntax so Node runs it from `src` (tests) and from `dist`.
 *
 * - **Discovery.** Every `.ts`/`.js` file below `<root>/tools` whose default export `defineTool`
 *   made is a declaration; its `run` is a project-relative path (as the SDK says), checked to stay
 *   inside the project once symlinks are followed, and imported.
 * - **Stateless.** A fresh MCP server and transport per request, as the gateway's own endpoint.
 * - **Context.** `signal` aborts on timeout or when the caller goes away; `runId` and `agent` come
 *   from the `x-aw-run-id` and `x-aw-agent` request headers.
 * - **Output.** Every stdout/stderr line is prefixed `[tool <name>]` (or `[tool host]`).
 *
 * **Hosted mode** (issue #791, ADR-0118 TS3-TS5): the tool sandbox serves the declarations a version
 * pinned, each a bundle whose default export is the run function, on `<host>:<port>/mcp`. A caller
 * proves itself with `Authorization: Bearer <token>`, where the token is one of the strings in the
 * JSON array at `tokensFile`, read again on every request so a revoked token stops working at
 * once. There is no discovery and no path token; the environment is whatever the parent passed.
 * It also launches the version's pinned `stdio` MCP servers (issue #793, TS6) and serves each at
 * `/stdio/<name>/mcp` behind the same bearer check; it ends if one cannot start or later goes away.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { isCodeTool, type ToolRunContext } from '@indx-workspace/sdk/define';

import { startStdioServer, type StdioServer, type StdioServerDeclaration } from './stdio-bridge.ts';

interface Loaded {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly timeoutMs: number;
  readonly run: (input: unknown, context: ToolRunContext) => unknown;
  readonly parse: (input: unknown) => unknown;
}

const current = new AsyncLocalStorage<string>();

// ponytail: a line split across two writes is prefixed twice; buffer per stream if it matters.
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const prefix = `[tool ${current.getStore() ?? 'host'}] `;
    return (write as (...args: unknown[]) => boolean)(text.replace(/^(?=.)/gm, prefix), ...rest);
  };
}

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return filesBelow(file);
      return /(?<!\.d)\.[jt]s$/u.test(entry.name) ? [file] : [];
    }),
  );
  return nested.flat();
}

function parserFor(schema: Record<string, unknown>): (input: unknown) => unknown {
  let parser: z.ZodType;
  try {
    parser = z.fromJSONSchema(schema);
  } catch {
    // Arguments are the model's: a schema Zod cannot read refuses the tool, never passes them on.
    throw new Error('its input schema cannot be read for validation');
  }
  return (input) => {
    const parsed = parser.safeParse(input);
    if (parsed.success) return parsed.data;
    // BH061-048: one readable line per issue, never ZodError's raw JSON.
    throw new Error(`invalid input:\n${z.prettifyError(parsed.error)}`);
  };
}

/** The run file's real path, refused when it (or a symlink on the way) leaves the project. */
async function runFile(root: string, run: string, declaration: string): Promise<string> {
  const real = await realpath(path.join(root, ...run.split('/'))).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const beside = path.join(path.dirname(declaration), ...run.split('/'));
    const found = await realpath(beside).then(
      () => path.relative(root, beside).split(path.sep).join('/'),
      () => undefined,
    );
    if (found === undefined) throw error;
    throw new Error(`run '${run}' not found: run is project-relative; did you mean './${found}'?`);
  });
  const relative = path.relative(await realpath(root), real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${run} is outside the project`);
  }
  return real;
}

async function defaultExport(file: string): Promise<unknown> {
  return ((await import(pathToFileURL(file).href)) as { default?: unknown }).default;
}

async function discover(root: string): Promise<Loaded[]> {
  const found: Loaded[] = [];
  for (const file of (await filesBelow(path.join(root, 'tools'))).sort()) {
    try {
      const declaration = await defaultExport(file);
      if (!isCodeTool(declaration)) continue;
      const run = await defaultExport(await runFile(root, declaration.run, file));
      if (typeof run !== 'function') {
        throw new Error(`${declaration.run} must export a function as its default`);
      }
      found.push({
        name: declaration.name,
        description: declaration.description,
        inputSchema: declaration.inputSchema,
        timeoutMs: declaration.limits.timeoutMs,
        run: run as Loaded['run'],
        parse: parserFor(declaration.inputSchema),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`${path.relative(root, file)}: ${reason}`);
    }
  }
  return found;
}

/** One tool a hosted sandbox serves: the pinned declaration and where its bundle was written. */
interface HostedDeclaration {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly timeoutMs: number;
  readonly file: string;
}

async function loadHosted(declared: readonly HostedDeclaration[]): Promise<Loaded[]> {
  const found: Loaded[] = [];
  for (const tool of declared) {
    try {
      const run = await defaultExport(tool.file);
      if (typeof run !== 'function') {
        throw new Error('its bundle must export a function as its default');
      }
      found.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        timeoutMs: tool.timeoutMs,
        run: run as Loaded['run'],
        parse: parserFor(tool.inputSchema),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`${tool.name}: ${reason}`);
    }
  }
  return found;
}

const digestOf = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Whether the request carries a bearer token that is in `tokensFile` now. */
async function bearerAccepted(
  tokensFile: string,
  authorization: string | string[] | undefined,
): Promise<boolean> {
  const presented = /^Bearer (\S+)$/u.exec(header(authorization))?.[1];
  if (presented === undefined) return false;
  // A file that is missing, half-written or not JSON admits nobody; it must not end the host.
  const tokens: unknown = await readFile(tokensFile, 'utf8')
    .then((raw) => JSON.parse(raw) as unknown)
    .catch(() => []);
  if (!Array.isArray(tokens)) return false;
  const wanted = digestOf(presented);
  return tokens.reduce<boolean>(
    (accepted, token) =>
      (typeof token === 'string' && timingSafeEqual(digestOf(token), wanted)) || accepted,
    false,
  );
}

function header(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function text(value: string, isError: boolean) {
  return { ...(isError ? { isError } : {}), content: [{ type: 'text' as const, text: value }] };
}

async function call(
  tool: Loaded,
  args: unknown,
  outer: AbortSignal,
  context: Omit<ToolRunContext, 'signal'>,
) {
  const signal = AbortSignal.any([outer, AbortSignal.timeout(tool.timeoutMs)]);
  // The run may ignore its signal; the call still ends at the limit.
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(
          new Error(
            outer.aborted
              ? 'the call was cancelled'
              : `${tool.name} timed out after ${String(tool.timeoutMs)} ms`,
          ),
        );
      },
      { once: true },
    );
  });
  aborted.catch(() => undefined);
  try {
    const result = await Promise.race([
      current.run(tool.name, () =>
        Promise.resolve(tool.run(tool.parse(args ?? {}), { ...context, signal })),
      ),
      aborted,
    ]);
    return text(
      typeof result === 'string' ? result : (JSON.stringify(result ?? null) ?? 'null'),
      false,
    );
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), true);
  }
}

interface LocalConfig {
  readonly root: string;
  readonly port: number;
  readonly token: string;
}

interface HostedConfig {
  readonly mode: 'hosted';
  readonly host: string;
  readonly port: number;
  readonly tokensFile: string;
  readonly tools: readonly HostedDeclaration[];
  readonly stdioServers?: readonly StdioServerDeclaration[];
}

/** What one MCP endpoint answers: the tools it lists and how a call to one of them runs. */
interface Front {
  readonly list: () => readonly Tool[];
  readonly call: (
    name: string,
    args: unknown,
    signal: AbortSignal,
    context: Omit<ToolRunContext, 'signal'>,
  ) => Promise<CallToolResult>;
}

async function main(): Promise<void> {
  const config = JSON.parse(process.env['AW_TOOL_HOST'] ?? '{}') as LocalConfig | HostedConfig;
  const hosted = 'mode' in config ? config : undefined;
  if (hosted !== undefined) delete process.env['AW_TOOL_HOST'];
  const { port } = config;
  const [tools, endpoint] =
    'mode' in config
      ? [await loadHosted(config.tools), '/mcp']
      : [await discover(config.root), `/${config.token}/mcp`];
  // A sandbox serves exactly what a version pinned and nothing restarts it: never a partial set.
  if (hosted !== undefined && tools.length !== hosted.tools.length) process.exit(1);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const codeTools: Front = {
    list: () =>
      tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema: { ...inputSchema, type: 'object' as const },
      })),
    call: (name, args, signal, context) => {
      const tool = byName.get(name);
      if (tool === undefined) return Promise.resolve(text(`unknown tool ${name}`, true));
      return call(tool, args, signal, context);
    },
  };

  const stdio = new Map<string, StdioServer>();
  // A server closed on purpose has not gone away: its `onClosed` must not end the host.
  let closing = false;
  const closeStdio = async (): Promise<void> => {
    closing = true;
    await Promise.all([...stdio.values()].map((server) => server.close().catch(() => undefined)));
  };
  // Started together, so the start takes as long as the slowest server, not the sum of them.
  const declarations = hosted?.stdioServers ?? [];
  const started = await Promise.allSettled(
    declarations.map((declaration) =>
      startStdioServer(declaration, {
        onStderr: (name, chunk) => {
          current.run(`stdio ${name}`, () => process.stderr.write(chunk));
        },
        onClosed: (name) => {
          if (closing) return;
          console.error(`stdio server ${name} exited`);
          process.exit(1);
        },
      }),
    ),
  );
  let failed = false;
  started.forEach((result, index) => {
    const name = declarations[index]?.name ?? '';
    if (result.status === 'fulfilled') {
      stdio.set(name, result.value);
      return;
    }
    failed = true;
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    console.error(`stdio server ${name}: ${reason}`);
  });
  if (failed) {
    await closeStdio();
    process.exit(1);
  }
  process.once('SIGTERM', () => {
    void closeStdio().finally(() => process.exit(0));
  });
  const fronts = new Map<string, Front>([
    [endpoint, codeTools],
    ...[...stdio.values()].map((server): [string, Front] => [
      `/stdio/${server.name}/mcp`,
      {
        list: () => server.tools,
        call: (name, args, signal) => server.call(name, args, signal),
      },
    ]),
  ]);

  const serve = (req: IncomingMessage, res: ServerResponse, front: Front): void => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const context = {
          runId: header(req.headers['x-aw-run-id']),
          agent: decodeURIComponent(header(req.headers['x-aw-agent'])),
        };
        // A stateless server never sees a `notifications/cancelled` (it goes to another request's
        // server), so a caller that hangs up is what cancels the call.
        const gone = new AbortController();
        res.on('close', () => {
          if (!res.writableFinished) gone.abort();
        });
        const server = new Server(
          { name: 'aw-dev-tools', version: '1.0.0' },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...front.list()] }));
        server.setRequestHandler(CallToolRequestSchema, ({ params }, extra) =>
          front.call(
            params.name,
            params.arguments,
            AbortSignal.any([extra.signal, gone.signal]),
            context,
          ),
        );
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
        await server.connect(transport);
        res.on('close', () => void server.close());
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        await transport.handleRequest(req, res, body);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(400);
        res.end();
      });
    });
  };

  const http = createServer((req, res) => {
    const front = fronts.get(req.url ?? '');
    if (front === undefined) {
      req.resume();
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      req.resume();
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    if (hosted !== undefined) {
      void bearerAccepted(hosted.tokensFile, req.headers.authorization).then((accepted) => {
        if (accepted) {
          serve(req, res, front);
        } else {
          req.resume();
          res.writeHead(401).end();
        }
      });
      return;
    }
    serve(req, res, front);
  });

  http.listen(port, hosted?.host ?? '127.0.0.1', () => {
    process.send?.({
      type: 'ready',
      tools: [...tools.map((tool) => tool.name), ...[...stdio.keys()].map((n) => `stdio:${n}`)],
    });
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
