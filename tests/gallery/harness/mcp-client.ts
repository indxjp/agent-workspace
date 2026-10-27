/**
 * Talk to a gallery MCP server the way the platform does for a remote connector: spawn it on a
 * free port with `MCP_TRANSPORT=http`, send `initialize`, and call its tools as Streamable HTTP
 * POSTs. Over HTTP a call can carry headers, which is how `x-aw-identity` reaches a server.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface McpToolResult {
  readonly text: string;
  readonly isError: boolean;
}

export interface McpCallOptions {
  /** Request headers for this call, such as `x-aw-identity`. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * The canonical calls a person approved for this run (`runs.approved_tool_calls`), which the
   * gateway reads from the run. Only the OpenAPI gateway double looks at it; an MCP server ignores it.
   */
  readonly approvedToolCalls?: readonly string[];
}

export interface McpSession {
  readonly tools: () => Promise<readonly string[]>;
  readonly call: (
    name: string,
    args: Record<string, unknown>,
    options?: McpCallOptions,
  ) => Promise<McpToolResult>;
  /** The parsed JSON of a successful call; throws with the tool's text when it reported an error. */
  readonly callJson: <T = unknown>(
    name: string,
    args: Record<string, unknown>,
    options?: McpCallOptions,
  ) => Promise<T>;
  /** One raw POST to `/mcp`: the status and body a server answers, a bad header's `401` included. */
  readonly post: (
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ) => Promise<{ readonly status: number; readonly body: string }>;
  readonly close: () => void;
}

interface JsonRpcReply {
  readonly error?: { readonly message: string };
  readonly result?: unknown;
}

const LISTENING = /^listening on 127\.0\.0\.1:(\d+)$/u;

/** Start `serverFile` with Node on a free port and complete the MCP handshake. */
export async function startMcpServer(
  serverFile: string,
  env: Readonly<Record<string, string>> = {},
): Promise<McpSession> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [serverFile], {
    env: { ...process.env, ...env, MCP_TRANSPORT: 'http', PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server did not start; stderr: ${stderr}`));
    }, 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`server exited before listening; stderr: ${stderr}`));
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      const found = LISTENING.exec(line);
      if (found?.[1] === undefined) return;
      clearTimeout(timer);
      resolve(Number(found[1]));
    });
  });

  async function post(
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<{ readonly status: number; readonly body: string }> {
    const response = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.text() };
  }

  let nextId = 1;
  async function request(
    method: string,
    params: unknown,
    headers?: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    const reply = await post({ jsonrpc: '2.0', id: nextId++, method, params }, headers);
    if (reply.status !== 200) throw new Error(`${method} answered ${String(reply.status)}`);
    const parsed = JSON.parse(reply.body) as JsonRpcReply;
    if (parsed.error !== undefined) throw new Error(parsed.error.message);
    return parsed.result;
  }

  await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'gallery-harness', version: '0' },
  });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

  async function call(
    name: string,
    args: Record<string, unknown>,
    options: McpCallOptions = {},
  ): Promise<McpToolResult> {
    const result = (await request('tools/call', { name, arguments: args }, options.headers)) as {
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
    callJson: async <T = unknown>(
      name: string,
      args: Record<string, unknown>,
      options?: McpCallOptions,
    ): Promise<T> => {
      const result = await call(name, args, options);
      if (result.isError) throw new Error(`${name} refused: ${result.text}`);
      return JSON.parse(result.text) as T;
    },
    post,
    close: () => {
      child.kill();
    },
  };
}
