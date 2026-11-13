/**
 * The live half of the `sse` probe: pumps the open event stream, resolves the `endpoint` event, and
 * correlates each asynchronous `message` event with the JSON-RPC request that is waiting for it.
 */
import { parseJsonRpcResponse, type JsonRpcResponse } from './json-rpc';
import { classifyFetchThrow } from './errno';
import { ProbeError, type ProbeFetch } from './probe-error';
import { parseSseFrame, splitSseFrames } from './sse-frames';

export interface SseSession {
  /** Resolves with the POST URL once the `endpoint` event arrives; rejects if the stream fails first. */
  readonly endpoint: Promise<string>;
  /** POST one JSON-RPC request and wait for its response on the stream. */
  readonly call: (id: number, request: Record<string, unknown>) => Promise<JsonRpcResponse>;
  /** POST a JSON-RPC payload that expects no response. */
  readonly notify: (payload: Record<string, unknown>) => Promise<void>;
}

export interface SseSessionInput {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly send: ProbeFetch;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
}

interface Pending {
  readonly resolve: (r: JsonRpcResponse) => void;
  readonly reject: (e: unknown) => void;
}

function resolveEndpointUrl(configuredUrl: string, data: string): string {
  const configured = new URL(configuredUrl);
  const candidate = new URL(data, configured);
  if (candidate.origin !== configured.origin) {
    throw new ProbeError(
      { kind: 'unknown', detail: 'the SSE endpoint event named a different origin' },
      'cross-origin SSE endpoint refused',
    );
  }
  return candidate.toString();
}

function parseJsonOrNull(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

class LiveSseSession implements SseSession {
  public readonly endpoint: Promise<string>;
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private postUrl: string | null = null;
  private terminal: ProbeError | null = null;
  private resolveEndpoint: ((u: string) => void) | null = null;
  private rejectEndpoint: ((e: unknown) => void) | null = null;

  public constructor(private readonly input: SseSessionInput) {
    this.endpoint = new Promise<string>((resolve, reject) => {
      this.resolveEndpoint = resolve;
      this.rejectEndpoint = reject;
    });
    // Not awaited directly: it runs for the life of the probe, feeding `pending` and `endpoint`.
    // Its own errors are reported through `failEverything`, never thrown here.
    this.pump().catch(() => undefined);
  }

  public readonly call = (
    id: number,
    request: Record<string, unknown>,
  ): Promise<JsonRpcResponse> => {
    if (this.terminal !== null) return Promise.reject(this.terminal);
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.notify(request).catch((error: unknown) => {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  };

  public readonly notify = async (payload: Record<string, unknown>): Promise<void> => {
    const { headers, signal, send } = this.input;
    if (this.postUrl === null) {
      throw new ProbeError(
        { kind: 'unknown', detail: 'no SSE endpoint yet' },
        'no SSE endpoint received',
      );
    }
    const postUrl = this.postUrl;
    let res: Response;
    try {
      res = await send(postUrl, {
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

  private failEverything(error: ProbeError): void {
    this.terminal ??= error;
    if (this.postUrl === null) this.rejectEndpoint?.(error);
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  private handleEndpointEvent(data: string): void {
    if (this.postUrl !== null) return;
    try {
      this.postUrl = resolveEndpointUrl(this.input.url, data);
    } catch (error) {
      if (!(error instanceof ProbeError)) throw error;
      this.failEverything(error);
      return;
    }
    this.resolveEndpoint?.(this.postUrl);
  }

  private handleMessageEvent(data: string): void {
    const parsed = parseJsonRpcResponse(parseJsonOrNull(data));
    if (parsed === null || typeof parsed.id !== 'number') return;
    const waiting = this.pending.get(parsed.id);
    if (waiting === undefined) return;
    this.pending.delete(parsed.id);
    waiting.resolve(parsed);
  }

  private handleFrame(frame: string): void {
    const event = parseSseFrame(frame);
    if (event === null) return;
    if (event.eventType === 'endpoint') this.handleEndpointEvent(event.data);
    else this.handleMessageEvent(event.data);
  }

  private handleChunk(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const { frames, rest } = splitSseFrames(this.buffer);
    this.buffer = rest;
    for (const frame of frames) this.handleFrame(frame);
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await this.input.reader.read();
        if (done) {
          this.failEverything(
            new ProbeError(
              { kind: 'sse-transport-error', text: 'stream ended before answering' },
              'SSE stream ended',
            ),
          );
          return;
        }
        this.handleChunk(value);
      }
    } catch (error) {
      // Torn down by the caller's deadline; not a fresh failure to report.
      if (this.input.signal.aborted) return;
      this.failEverything(new ProbeError(classifyFetchThrow(error), 'SSE stream read failed'));
    }
  }
}

export function startSseSession(input: SseSessionInput): SseSession {
  return new LiveSseSession(input);
}
