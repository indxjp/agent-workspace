/**
 * Issue #388: the routes `apps/web/proxy.ts` lets a workspace API key (`Bearer ak_live_…`) reach,
 * derived from the contracts' route catalogue rather than restated here.
 *
 * `ApiRoute.security` (`packages/contracts/src/routes.ts`) is absent exactly when a route takes
 * the default credentials — a workspace API key, a browser token or the session cookie (spec 04
 * §3.1: an API key is the credential of "backends, CI, the CLI"). Every other value names a
 * credential that is not an API key (`none`, `session-cookie`, `invitation-identity`,
 * `user-token`), and the runner-only routes are not in the catalogue at all
 * (`API_ROUTE_EXCLUSIONS`). So the set the edge admits a key on is a function of the catalogue,
 * and a route added to it with default security is admitted without a second list to update.
 *
 * This is the credential's *shape* only. The route verifies the key — hash, expiry, revocation —
 * through `identify()` and decides its role with `decide()`; a route that refuses API keys by
 * design (`/api/workspaces/**`, `/api/invitations/**`, ADR W9-WS-119) answers its own
 * `403 api_key_not_permitted` once the request reaches it.
 */
import { API_ROUTE_EXCLUSIONS, API_ROUTES, type ApiRoute } from '@indx-workspace/contracts/routes';

/** Whether a catalogue route accepts a workspace API key: it declares no non-default security. */
export function acceptsApiKey(route: Pick<ApiRoute, 'security'>): boolean {
  return route.security === undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** `/api/runs/:id/events` → `^/api/runs/[^/]+/events$`: one path segment per `:param`. */
export function pathPattern(path: string): RegExp {
  const segments = path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : escapeRegExp(segment)));
  return new RegExp(`^${segments.join('/')}$`, 'u');
}

interface ApiKeyRouteMatcher {
  readonly method: string;
  readonly pattern: RegExp;
}

const API_KEY_ROUTES: readonly ApiKeyRouteMatcher[] = API_ROUTES.filter(acceptsApiKey).map(
  (route) => ({ method: route.method, pattern: pathPattern(route.path) }),
);

/**
 * The method a route is matched under: `HEAD` is the `GET` it shadows, which Next answers from the
 * `GET` handler, so `curl -I` with a key reaches the same route a `GET` does (PR #418 review).
 */
function routeMethod(method: string): string {
  const upper = method.toUpperCase();
  return upper === 'HEAD' ? 'GET' : upper;
}

/** Whether `method` on `pathname` is a catalogue route a workspace API key may be presented on. */
export function isApiKeyRoute(method: string, pathname: string): boolean {
  const effective = routeMethod(method);
  return API_KEY_ROUTES.some((route) => route.method === effective && route.pattern.test(pathname));
}

/**
 * Every route the control plane serves under `/api/**`: the catalogue plus the routes it excludes
 * on purpose (sign-in steps, setup, the runner's private routes). The two together are the route
 * inventory, which `tests/route-declarations/**` checks against the files on disk.
 */
const SERVED_API_ROUTES: readonly ApiKeyRouteMatcher[] = [...API_ROUTES, ...API_ROUTE_EXCLUSIONS]
  .filter((route) => route.path.startsWith('/api/'))
  .map((route) => ({ method: route.method, pattern: pathPattern(route.path) }));

/** What the served route inventory says about one method on one `/api/**` path. */
export type ApiRouteMatch =
  | { readonly kind: 'served' }
  | { readonly kind: 'unknown' }
  /** The path is served, but not under this method; `allow` is what it is served under. */
  | { readonly kind: 'method-not-allowed'; readonly allow: readonly string[] };

/**
 * Issue #416: whether the control plane serves `method` on `pathname`, so a caller presenting a
 * workspace API key on a path no route serves is answered `404 not_found`, and on a served path
 * under the wrong method `405 method_not_allowed` with an `Allow` header — instead of a
 * session-cookie `401` that sends them looking for a credential problem.
 *
 * This is a function of the published route catalogue alone — never of the key, which the edge
 * does not verify — so answering it to any key-shaped bearer reveals nothing the contracts and
 * the OpenAPI document do not already publish. A request with no such bearer still gets `401`.
 */
export function matchApiRoute(method: string, pathname: string): ApiRouteMatch {
  const effective = routeMethod(method);
  const onPath = SERVED_API_ROUTES.filter((route) => route.pattern.test(pathname));
  if (onPath.length === 0) return { kind: 'unknown' };
  if (onPath.some((route) => route.method === effective)) return { kind: 'served' };
  const methods = new Set(onPath.map((route) => route.method));
  if (methods.has('GET')) methods.add('HEAD');
  return { kind: 'method-not-allowed', allow: [...methods].sort() };
}
