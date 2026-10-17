/**
 * The OAuth server's own routes (`/oauth/*`, `/.well-known/oauth-*`; ADR-0134 part 3), which the
 * catalogue lists as exclusions because their wire format is RFC 6749/8414/9728, not JSON problems.
 * `apps/web/proxy.ts` lets them through the session gate: the token and revoke endpoints
 * authenticate the client themselves, the metadata is public, and `/oauth/authorize` identifies the
 * member itself so it can send a signed-out one to `/signin` with a way back.
 */
import { API_ROUTE_EXCLUSIONS } from '@indx-workspace/contracts/routes';

import { pathPattern } from './api-key-routes';

const OAUTH_ROUTES = API_ROUTE_EXCLUSIONS.filter(
  (route) => route.path.startsWith('/oauth/') || route.path.startsWith('/.well-known/oauth-'),
).map((route) => ({ method: route.method, pattern: pathPattern(route.path) }));

/** Whether `method` on `pathname` is exactly one of the OAuth server's routes. */
export function isOAuthRoute(method: string, pathname: string): boolean {
  const effective = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return OAUTH_ROUTES.some((route) => route.method === effective && route.pattern.test(pathname));
}
