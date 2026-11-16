import { noStoreResultResponse, problem } from '../http/result';
import { log } from '../telemetry/logger';
import { checkRequestOrigin } from './origin';
import { storeOriginFor } from './store-origin';

/**
 * The same-origin check of a pre-session route (one the proxy exempts from its session gate, so
 * it does its own): this host's own pages, or the Agent Store's origin, which calls these routes
 * from its own site (`store-origin.ts`); `storeBaseUrl` is `AW_EMAIL_LINK_BASE_URL` as the composition
 * root read it, `null` when unset. `null` to go on, or the `403 cross_origin` to answer.
 */
export function crossOrigin(request: Request, storeBaseUrl: string | null): Response | null {
  const origin = request.headers.get('origin');
  const store = storeOriginFor({
    origin,
    baseUrl: storeBaseUrl,
    method: request.method,
    pathname: new URL(request.url).pathname,
    via: null,
  });
  const verdict = checkRequestOrigin({
    method: request.method,
    origin,
    ...(store === null ? {} : { allowedOrigins: [store] }),
    requestHost: new URL(request.url).host,
    hostHeader: request.headers.get('host'),
    forwardedHost: request.headers.get('x-forwarded-host'),
  });
  if (verdict.ok) return null;
  log.warn('[auth] cross-origin pre-session request refused', { reason: verdict.reason });
  return noStoreResultResponse(problem(403, 'cross_origin', 'Cross-origin requests are refused.'));
}
