/**
 * The `sse` transport probe — MCP's legacy HTTP+SSE transport. A GET opens a `text/event-stream`;
 * the first `endpoint` event names the URL to POST JSON-RPC requests to, and every response
 * arrives asynchronously as a `message` event on the SAME stream, correlated by JSON-RPC id.
 *
 * R-06 §4.3's warning applies directly here: nothing is "in flight" until the `endpoint` event
 * arrives, so a server that opens the stream and never writes anything has no request for a
 * per-call timeout to fire on. This probe relies entirely on the CALLER's wall-clock deadline
 * (`test-connection.ts`'s `Promise.race`) for that case — it does not invent a second one.
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

export interface SseProbeResult {
  readonly serverName: string | null;
  readonly serverVersion: string | null;
  readonly toolCount: number;
}

const EVENT_STREAM_CONTENT_TYPE = 'text/event-stream';

interface Pending {
  readonly resolve: (r: JsonRpcResponse) => void;
  readonly reject: (e: unknown) => void;
}

function classifyJsonRpcError(code: number, message: string): ProbeError {
  if (code <= -32000 && code >= -32099) {
    return new ProbeError({ kind: 'json-rpc-app-error', code, message }, message);
  }
  return new ProbeError({ kind: 'json-rpc-protocol-error', code }, message);
}

export async function probeSse(
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<SseProbeResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { ...headers, accept: EVENT_STREAM_CONTENT_TYPE },
      signal,
      redirect: 'error',
    });
  } catch (error) {
    throw new ProbeError(classifyFetchThrow(error), `GET ${url} failed`);
  }
  if (!response.ok) {
    throw new ProbeError(
      { kind: 'http-status', status: response.status },
      `${url} -> HTTP ${String(response.status)}`,
    );
  }
  const contentType =
    (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (contentType !== EVENT_STREAM_CONTENT_TYPE) {
    throw new ProbeError(
      { kind: 'not-json-rpc' },
      `${url} did not open an SSE stream (content-type ${JSON.stringify(contentType)})`,
    );
  }
  const body = response.body;
  if (body === null) {
    throw new ProbeError(
      { kind: 'sse-transport-error', text: 'empty response body' },
      'empty SSE body',
    );
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let postUrl: string | null = null;
  let resolveEndpoint: ((u: string) => void) | null = null;
  let rejectEndpoint: ((e: unknown) => void) | null = null;
  const endpointPromise = new Promise<string>((resolve, reject) => {
    resolveEndpoint = resolve;
    rejectEndpoint = reject;
  });

  const pending = new Map<number, Pending>();
  let terminal: ProbeError | null = null;

  const failEverything = (error: ProbeError): void => {
    terminal ??= error;
    if (postUrl === null) rejectEndpoint?.(error);
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  const handleFrame = (frame: string): void => {
    let eventType = 'message';
    const dataLines: string[] = [];
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith('event:')) eventType = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');

    if (eventType === 'endpoint') {
      if (postUrl === null) {
        const configuredUrl = new URL(url);
        const candidate = new URL(data, configuredUrl);
        if (candidate.origin !== configuredUrl.origin) {
          failEverything(
            new ProbeError(
              {
                kind: 'unknown',
                detail: 'the SSE endpoint event named a different origin',
              },
              'cross-origin SSE endpoint refused',
            ),
          );
          return;
        }
        postUrl = candidate.toString();
        resolveEndpoint?.(postUrl);
      }
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(data) as unknown;
    } catch {
      return;
    }
    const parsed = parseJsonRpcResponse(raw);
    if (parsed === null || typeof parsed.id !== 'number') return;
    const waiting = pending.get(parsed.id);
    if (waiting === undefined) return;
    pending.delete(parsed.id);
    waiting.resolve(parsed);
  };

  const pump = async (): Promise<void> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          failEverything(
            new ProbeError(
              { kind: 'sse-transport-error', text: 'stream ended before answering' },
              'SSE stream ended',
            ),
          );
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          handleFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (signal.aborted) return; // Torn down by the caller's deadline; not a fresh failure to report.
      failEverything(new ProbeError(classifyFetchThrow(error), 'SSE stream read failed'));
    }
  };
  // Not awaited directly: it runs for the life of the probe, feeding `pending` and
  // `endpointPromise`. Its own errors are reported through `failEverything`, never thrown here.
  const pumpPromise = pump();
  pumpPromise.catch(() => undefined);

  const postJson = async (payload: Record<string, unknown>): Promise<void> => {
    if (postUrl === null) {
      throw new ProbeError(
        { kind: 'unknown', detail: 'no SSE endpoint yet' },
        'no SSE endpoint received',
      );
    }
    let res: Response;
    try {
      res = await fetch(postUrl, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
        redirect: 'error',
      });
    } catch (error) {
      throw new ProbeError(classifyFetchThrow(error), `POST ${postUrl} failed`);
    }
    if (!res.ok) {
      throw new ProbeError(
        { kind: 'http-status', status: res.status },
        `${postUrl} -> HTTP ${String(res.status)}`,
      );
    }
  };

  const call = (id: number, request: Record<string, unknown>): Promise<JsonRpcResponse> => {
    if (terminal !== null) return Promise.reject(terminal);
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      postJson(request).catch((error: unknown) => {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  };

  try {
    await endpointPromise;

    const initResponse = await call(1, buildInitializeRequest(1));
    if (initResponse.kind === 'error')
      throw classifyJsonRpcError(initResponse.error.code, initResponse.error.message);
    const { protocolVersion, serverName, serverVersion } = readInitializeResult(
      initResponse.result,
    );
    if (protocolVersion !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
      throw new ProbeError(
        { kind: 'protocol-version-unsupported', version: protocolVersion },
        `unsupported protocol version ${protocolVersion}`,
      );
    }

    await postJson(buildInitializedNotification()).catch(() => undefined);

    const listResponse = await call(2, buildToolsListRequest(2));
    if (listResponse.kind === 'error')
      throw classifyJsonRpcError(listResponse.error.code, listResponse.error.message);
    return { serverName, serverVersion, toolCount: readToolCount(listResponse.result) };
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed by the abort — nothing more to release.
    }
  }
}
