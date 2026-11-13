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
  readInitializeResult,
  readToolCount,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcResponse,
} from './json-rpc';
import { classifyFetchThrow } from './errno';
import { classifyJsonRpcError, ProbeError, type ProbeFetch } from './probe-error';
import { startSseSession } from './sse-session';

export { splitSseFrames } from './sse-frames';

export interface SseProbeResult {
  readonly serverName: string | null;
  readonly serverVersion: string | null;
  readonly toolCount: number;
}

const EVENT_STREAM_CONTENT_TYPE = 'text/event-stream';

function contentTypeOf(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/** GET the stream and return its body, or throw the ProbeError that says why it is not an SSE stream. */
async function openEventStream(
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  send: ProbeFetch,
): Promise<ReadableStream<Uint8Array>> {
  let response: Response;
  try {
    response = await send(url, {
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
  const contentType = contentTypeOf(response);
  if (contentType !== EVENT_STREAM_CONTENT_TYPE) {
    throw new ProbeError(
      { kind: 'not-json-rpc' },
      `${url} did not open an SSE stream (content-type ${JSON.stringify(contentType)})`,
    );
  }
  if (response.body === null) {
    throw new ProbeError(
      { kind: 'sse-transport-error', text: 'empty response body' },
      'empty SSE body',
    );
  }
  return response.body;
}

function resultOrThrow(response: JsonRpcResponse): unknown {
  if (response.kind === 'error') {
    throw classifyJsonRpcError(response.error.code, response.error.message);
  }
  return response.result;
}

export async function probeSse(
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  send: ProbeFetch,
): Promise<SseProbeResult> {
  const body = await openEventStream(url, headers, signal, send);
  const reader = body.getReader();
  const session = startSseSession({ url, headers, signal, send, reader });

  try {
    await session.endpoint;

    const init = readInitializeResult(
      resultOrThrow(await session.call(1, buildInitializeRequest(1))),
    );
    const { protocolVersion } = init;
    if (protocolVersion !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
      throw new ProbeError(
        { kind: 'protocol-version-unsupported', version: protocolVersion },
        `unsupported protocol version ${protocolVersion}`,
      );
    }

    await session.notify(buildInitializedNotification()).catch(() => undefined);

    const tools = resultOrThrow(await session.call(2, buildToolsListRequest(2)));
    return {
      serverName: init.serverName,
      serverVersion: init.serverVersion,
      toolCount: readToolCount(tools),
    };
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed by the abort — nothing more to release.
    }
  }
}
