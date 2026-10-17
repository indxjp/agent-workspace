/**
 * The small slice of JSON-RPC 2.0 and MCP's `initialize` handshake this probe needs. No library:
 * this is well under spec §40's "~50 lines" bar for the framing itself, and JSON-RPC is not on
 * that section's list of things not to reimplement (cryptography, JWT, OAuth, database clients,
 * container protocols).
 *
 * MCP protocol versions from the R-06 research note §6, read out of the
 * pinned Agent SDK's own `.d.ts`/bundled sources — not guessed.
 */

/** What `@anthropic-ai/claude-agent-sdk@0.3.258` and `@modelcontextprotocol/sdk@1.30.0` both put
 *  on the wire (R-06 §6). Requested first; a server naming any of the rest still connects. */
export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** A parsed JSON-RPC response frame, after the base shape has been checked. */
export type JsonRpcResponse =
  | { readonly kind: 'result'; readonly id: number | string; readonly result: unknown }
  | {
      readonly kind: 'error';
      readonly id: number | string | null;
      readonly error: JsonRpcErrorObject;
    };

/** Build the `initialize` request this probe sends on every transport. */
export function buildInitializeRequest(id: number): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'agent-workspace-connection-test', version: '1' },
    },
  };
}

export function buildInitializedNotification(): Record<string, unknown> {
  return { jsonrpc: '2.0', method: 'notifications/initialized' };
}

export function buildToolsListRequest(id: number): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/list', params: {} };
}

/**
 * Parse one candidate JSON-RPC response object (already `JSON.parse`d). `null` when `raw` is not
 * shaped like a JSON-RPC 2.0 response at all — the caller reports that as `not-json-rpc`, never as
 * a guess about what it might have meant (ADR-0015).
 */
export function parseJsonRpcResponse(raw: unknown): JsonRpcResponse | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (obj['jsonrpc'] !== '2.0') return null;

  if ('error' in obj) {
    const err = obj['error'];
    if (typeof err !== 'object' || err === null) return null;
    const errObj = err as Record<string, unknown>;
    if (typeof errObj['code'] !== 'number' || typeof errObj['message'] !== 'string') return null;
    const id = obj['id'];
    const idOk =
      typeof id === 'number' || typeof id === 'string' || id === null || id === undefined;
    if (!idOk) return null;
    const errorObject: JsonRpcErrorObject =
      'data' in errObj
        ? { code: errObj['code'], message: errObj['message'], data: errObj['data'] }
        : { code: errObj['code'], message: errObj['message'] };
    return { kind: 'error', id: id === undefined ? null : id, error: errorObject };
  }

  if ('result' in obj) {
    const id = obj['id'];
    if (typeof id !== 'number' && typeof id !== 'string') return null;
    return { kind: 'result', id, result: obj['result'] };
  }

  return null;
}

/** The subset of `InitializeResult` this probe reads. Absent/malformed fields read as `null`. */
export interface InitializeResultShape {
  readonly protocolVersion: string | null;
  readonly serverName: string | null;
  readonly serverVersion: string | null;
}

export function readInitializeResult(result: unknown): InitializeResultShape {
  if (typeof result !== 'object' || result === null) {
    return { protocolVersion: null, serverName: null, serverVersion: null };
  }
  const obj = result as Record<string, unknown>;
  const protocolVersion =
    typeof obj['protocolVersion'] === 'string' ? obj['protocolVersion'] : null;
  const info = obj['serverInfo'];
  let serverName: string | null = null;
  let serverVersion: string | null = null;
  if (typeof info === 'object' && info !== null) {
    const infoObj = info as Record<string, unknown>;
    if (typeof infoObj['name'] === 'string') serverName = infoObj['name'];
    if (typeof infoObj['version'] === 'string') serverVersion = infoObj['version'];
  }
  return { protocolVersion, serverName, serverVersion };
}

/** How many tools a `tools/list` result named. `0` for anything that is not a `tools` array — the
 *  probe has already proven `initialize` succeeded by this point, so a malformed list is reported
 *  as zero tools rather than as a fresh failure kind nothing asked for. */
export function readToolCount(result: unknown): number {
  if (typeof result !== 'object' || result === null) return 0;
  const tools = (result as Record<string, unknown>)['tools'];
  return Array.isArray(tools) ? tools.length : 0;
}
