/**
 * Talk to a gallery MCP server the way a run's engine does: spawn it as a `stdio` process, send
 * `initialize`, and call its tools over newline-delimited JSON-RPC.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface McpToolResult {
  readonly text: string;
  readonly isError: boolean;
}

export interface McpSession {
  readonly tools: () => Promise<readonly string[]>;
  readonly call: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  /** The parsed JSON of a successful call; throws with the tool's text when it reported an error. */
  readonly callJson: <T = unknown>(name: string, args: Record<string, unknown>) => Promise<T>;
  readonly close: () => void;
}

interface JsonRpcReply {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly message: string };
}

function isReply(value: unknown): value is JsonRpcReply {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'number'
  );
}

/** Start `serverFile` with Node and complete the MCP handshake. */
export async function startMcpServer(
  serverFile: string,
  env: Readonly<Record<string, string>> = {},
): Promise<McpSession> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [serverFile], {
    env: { ...process.env, ...env, MCP_TRANSPORT: 'stdio' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, (reply: JsonRpcReply) => void>();
  let nextId = 1;
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const parsed: unknown = JSON.parse(line);
    if (isReply(parsed)) pending.get(parsed.id)?.(parsed);
  });

  function request(method: string, params: unknown): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${method} timed out; server stderr: ${stderr}`));
      }, 10_000);
      pending.set(id, (reply) => {
        clearTimeout(timer);
        pending.delete(id);
        if (reply.error !== undefined) reject(new Error(reply.error.message));
        else resolve(reply.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'gallery-harness', version: '0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  async function call(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = (await request('tools/call', { name, arguments: args })) as {
      content: readonly { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = result.content.map((block) => block.text ?? '').join('');
    return { text, isError: result.isError === true };
  }

  return {
    tools: async () => {
      const result = (await request('tools/list', {})) as { tools: readonly { name: string }[] };
      return result.tools.map((tool) => tool.name);
    },
    call,
    callJson: async <T = unknown>(name: string, args: Record<string, unknown>): Promise<T> => {
      const result = await call(name, args);
      if (result.isError) throw new Error(`${name} refused: ${result.text}`);
      return JSON.parse(result.text) as T;
    },
    close: () => {
      child.kill();
    },
  };
}
