/**
 * ADR-0161 D9: the routes an access token from `POST /api/auth/token-exchange` is admitted on —
 * exactly the `app-backend` scope grammar's route shapes (D8), named by their catalogue operations
 * so a moved path moves here too.
 *
 * One list, read at two layers so neither is the only gate: `apps/web/proxy.ts` lets an
 * `awo_live_` bearer past the edge on these routes, and `session-rbac.ts`'s `resolveActor` resolves
 * one here only when its client is an `app-backend` client. `decide()` still narrows the request to
 * the client's bound agents and the person's own grants.
 *
 * Pure and dependency-free apart from the catalogue: the proxy imports it.
 */
import { API_ROUTES } from '@indx-workspace/contracts/routes';

import { pathPattern } from './api-key-routes';

/** The catalogue operations of the `app-backend` grammar, in ADR-0161 D8's order. */
export const APP_BACKEND_OPERATIONS: readonly string[] = [
  'runs.start',
  'runs.get',
  'runs.events',
  'runs.interrupt',
  'me',
];

const APP_BACKEND_ROUTES = API_ROUTES.filter((route) =>
  APP_BACKEND_OPERATIONS.includes(route.operationId),
).map((route) => ({ method: route.method, path: route.path, pattern: pathPattern(route.path) }));

/** The `METHOD /path` shapes the list admits, for tests and review. */
export const APP_BACKEND_ROUTE_SHAPES: readonly string[] = APP_BACKEND_ROUTES.map(
  (route) => `${route.method} ${route.path}`,
);

/** Whether `method` on `pathname` is exactly one of the `app-backend` grammar's routes. */
export function isAppBackendRoute(method: string, pathname: string): boolean {
  const effective = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return APP_BACKEND_ROUTES.some(
    (route) => route.method === effective && route.pattern.test(pathname),
  );
}
