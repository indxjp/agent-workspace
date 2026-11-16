import { isProtocolErrorRange, type ProbeSignal } from '../classify';

/** Thrown by a transport probe on any failure. Carries the positive fact the wire code
 *  established — see `classify.ts` for why this is a closed set of signals, not a message. */
export class ProbeError extends Error {
  public readonly signal: ProbeSignal;

  public constructor(signal: ProbeSignal, message: string) {
    super(message);
    this.name = 'ProbeError';
    this.signal = signal;
  }
}

/**
 * A wall-clock deadline for the WHOLE probe (R-06 §4.3): started once, before the transport opens,
 * and covering every step through `tools/list`. Needed on top of any per-call timeout because the
 * `sse` handshake has no request in flight to time out — nothing is sent until an `endpoint` event
 * arrives, so a per-request timeout bounds nothing and a black-holing server parks the probe
 * forever without it.
 */
export function createDeadline(timeoutMs: number): {
  readonly promise: Promise<never>;
  readonly cancel: () => void;
  readonly signal: AbortSignal;
} {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProbeError({ kind: 'timeout' }, `no answer within ${String(timeoutMs)}ms`));
    }, timeoutMs);
  });
  return {
    promise,
    cancel: (): void => {
      clearTimeout(timer);
    },
    signal: controller.signal,
  };
}

/** Every fetch the probes make. Production binds this to the egress guard (`guardedFetch`), so a
 *  caller-supplied URL can never reach an internal address from the control plane. */
export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A JSON-RPC error object the peer sent. Only JSON-RPC's OWN pre-defined range (-32700..-32600)
 * means "speaks JSON-RPC but is not MCP"; any other code (MCP's -32000..-32099, HTTP-style
 * numbers, vendor codes) is an application error from a server that did answer.
 */
export function classifyJsonRpcError(code: number, message: string): ProbeError {
  if (isProtocolErrorRange(code)) {
    return new ProbeError({ kind: 'json-rpc-protocol-error', code }, message);
  }
  return new ProbeError({ kind: 'json-rpc-app-error', code, message }, message);
}
