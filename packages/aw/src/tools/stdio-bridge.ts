/**
 * The `stdio` MCP servers of a hosted tool sandbox (ADR-0118 TS6; issue #793): each is launched once
 * as a child of the tool host, with the host's own environment (exactly the secrets the session
 * declared, TS4) and nothing on its command line but the pinned package, and is spoken to as an MCP
 * client. The host serves what the server lists at `/stdio/<name>/mcp`, behind the same bearer check
 * as the tools. The tool list is read once at start; a server that changes it is not followed.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

/** One server a version pinned: `command` and `args` are validated by the manifest schema. */
export interface StdioServerDeclaration {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export interface StdioServer {
  readonly name: string;
  readonly tools: readonly Tool[];
  readonly call: (tool: string, args: unknown, signal: AbortSignal) => Promise<CallToolResult>;
  readonly close: () => Promise<void>;
}

/** Long enough for `npx` to fetch a pinned package through the proxy, short enough to fail a stuck start. */
const STDIO_START_TIMEOUT_MS = 90_000;

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * Launch and initialize one server. `onStderr` receives its diagnostics; `onClosed` is called when
 * the server goes away after it started. Rejects if the server cannot be started or initialized.
 */
export async function startStdioServer(
  declaration: StdioServerDeclaration,
  hooks: {
    readonly onStderr: (name: string, chunk: string) => void;
    readonly onClosed: (name: string) => void;
  },
): Promise<StdioServer> {
  const { name, command, args, timeoutMs } = declaration;
  const transport = new StdioClientTransport({
    command,
    args: [...args],
    env: stringEnvironment(process.env),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    hooks.onStderr(name, chunk.toString('utf8'));
  });
  const client = new Client({ name: 'aw-tool-host', version: '1.0.0' });
  let started = false;
  client.onclose = () => {
    if (started) hooks.onClosed(name);
  };
  try {
    await client.connect(transport, { timeout: STDIO_START_TIMEOUT_MS });
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? {} : { cursor }, {
        timeout: STDIO_START_TIMEOUT_MS,
      });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    started = true;
    return {
      name,
      tools,
      call: async (tool, callArgs, signal) =>
        (await client.callTool(
          {
            name: tool,
            ...(typeof callArgs === 'object' && callArgs !== null
              ? { arguments: callArgs as Record<string, unknown> }
              : {}),
          },
          undefined,
          { signal, timeout: timeoutMs },
        )) as CallToolResult,
      close: () => client.close(),
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}
