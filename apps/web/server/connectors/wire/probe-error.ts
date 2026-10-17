import type { ProbeSignal } from '../classify';

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
