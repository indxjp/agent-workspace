import { markRealNetworkTransport } from '@agent-workspace/core';
import type { Logger } from '@agent-workspace/core/telemetry';

/**
 * `fetch`, logging the host of each upstream model call and nothing else: no path, header or body.
 * It lets a deployment prove which API its model traffic reached.
 */
export function loggedFetch(log: Logger, base: typeof fetch = fetch): typeof fetch {
  const logged: typeof fetch = (input, init) => {
    const raw = input instanceof Request ? input.url : input;
    let host = 'unparsable';
    try {
      host = new URL(raw).host;
    } catch {
      // Logged as 'unparsable'; the request itself is left to fail in `fetch`.
    }
    log.info('model upstream request', { host });
    return base(input, init);
  };
  // Wrapping the real `fetch` must not turn it into a test double in the eyes of `guardedFetch`,
  // which pins an `http:` target to the address it checked only for the real network.
  return base === fetch ? markRealNetworkTransport(logged) : logged;
}
