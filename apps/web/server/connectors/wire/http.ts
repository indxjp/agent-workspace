/**
 * The `http` transport probe (MCP "Streamable HTTP") — one POST per JSON-RPC call, `fetch`-based,
 * no library. Simplified relative to the full Streamable HTTP spec: it does not resume a dropped
 * stream and does not implement DELETE-to-terminate, neither of which a Test Connection needs —
 * see this task's PR for the declared gap.
 */
import {
  buildInitializedNotification,
  buildInitializeRequest,
  buildToolsListRequest,
  parseJsonRpcResponse,
  readInitializeResult,
  readToolCount,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcResponse,
} from './json-rpc';
import { classifyFetchThrow } from './errno';
import { ProbeError } from './probe-error';

export interface HttpProbeResult {
  readonly serverName: string | null;
  readonly serverVersion: string | null;
  readonly toolCount: number;
}

const JSON_CONTENT_TYPE = 'application/json';
const EVENT_STREAM_CONTENT_TYPE = 'text/event-stream';

/** Read the first complete SSE `data:` line's JSON payload out of a response body's full text. */
function firstSseDataPayload(text: string): unknown {
  for (const frame of text.split('\n\n')) {
    for (const line of frame.split('\n')) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('data:')) {
        const payload = trimmed.slice('data:'.length).trim();
        try {
          return JSON.parse(payload) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** POST one JSON-RPC request/notification. Returns the parsed response for a request; `null` for
 *  a notification (no id, no response expected) once the send itself succeeded. */
async function post(
  url: string,
  headers: Readonly<Record<string, string>>,
  body: Record<string, unknown>,
  signal: AbortSignal,
  sessionId: string | null,
): Promise<{ readonly response: Response; readonly sessionId: string | null }> {
  const requestHeaders: Record<string, string> = {
    ...headers,
    'content-type': JSON_CONTENT_TYPE,
    accept: `${JSON_CONTENT_TYPE}, ${EVENT_STREAM_CONTENT_TYPE}`,
  };
  if (sessionId !== null) requestHeaders['mcp-session-id'] = sessionId;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal,
      // Credentials belong to the configured endpoint. A redirect must never forward an API-key
      // header or bearer token to a location chosen by the response.
      redirect: 'error',
    });
  } catch (error) {
    throw new ProbeError(classifyFetchThrow(error), `POST ${url} failed`);
  }
  const nextSession = response.headers.get('mcp-session-id') ?? sessionId;
  return { response, sessionId: nextSession };
}

/** Turn a non-OK response, or a JSON-RPC error body, into the right {@link ProbeError}. Returns
 *  the parsed JSON-RPC response when the call actually succeeded. */
async function requireJsonRpcResult(
  response: Response,
  url: string,
): Promise<JsonRpcResponse & { readonly kind: 'result' }> {
  if (!response.ok) {
    throw new ProbeError(
      { kind: 'http-status', status: response.status },
      `${url} -> HTTP ${String(response.status)}`,
    );
  }
  const contentType =
    (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const text = await response.text();
  let raw: unknown;
  if (contentType === JSON_CONTENT_TYPE) {
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      throw new ProbeError({ kind: 'not-json-rpc' }, `${url} did not return valid JSON`);
    }
  } else if (contentType === EVENT_STREAM_CONTENT_TYPE) {
    const payload = firstSseDataPayload(text);
    if (payload === null) {
      throw new ProbeError(
        { kind: 'not-json-rpc' },
        `${url} opened an event stream with no JSON-RPC frame`,
      );
    }
    raw = payload;
  } else {
    throw new ProbeError(
      { kind: 'not-json-rpc' },
      `${url} answered with content-type ${JSON.stringify(contentType)}`,
    );
  }

  const parsed = parseJsonRpcResponse(raw);
  if (parsed === null) {
    throw new ProbeError(
      { kind: 'not-json-rpc' },
      `${url} did not answer with a JSON-RPC 2.0 frame`,
    );
  }
  if (parsed.kind === 'error') {
    const { code, message } = parsed.error;
    if (code <= -32000 && code >= -32099) {
      throw new ProbeError({ kind: 'json-rpc-app-error', code, message }, message);
    }
    throw new ProbeError({ kind: 'json-rpc-protocol-error', code }, message);
  }
  return parsed;
}

/**
 * Run the full MCP lifecycle over `http`: `initialize` → validate protocol version →
 * `notifications/initialized` → `tools/list`.
 */
export async function probeHttp(
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<HttpProbeResult> {
  const init = await post(url, headers, buildInitializeRequest(1), signal, null);
  const initResult = await requireJsonRpcResult(init.response, url);
  const { protocolVersion, serverName, serverVersion } = readInitializeResult(initResult.result);
  if (protocolVersion !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    throw new ProbeError(
      { kind: 'protocol-version-unsupported', version: protocolVersion },
      `unsupported protocol version ${protocolVersion}`,
    );
  }

  // Fire-and-forget: a notification has no id and the server is not required to answer it.
  await post(url, headers, buildInitializedNotification(), signal, init.sessionId).catch(
    () => undefined,
  );

  const list = await post(url, headers, buildToolsListRequest(2), signal, init.sessionId);
  const listResult = await requireJsonRpcResult(list.response, url);
  return { serverName, serverVersion, toolCount: readToolCount(listResult.result) };
}
