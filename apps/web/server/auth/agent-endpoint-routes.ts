/**
 * The routes whose catalogue entry declares `security: 'endpoint-credential'` (ADR-0135): a
 * published agent's public A2A endpoint. `apps/web/proxy.ts` lets these through the edge gate
 * with or without a credential, because the handler is the one that identifies the caller, refuses
 * every credential but an API key, and rate-limits it. Derived from the catalogue like
 * `api-key-routes.ts`, so a route added with this security needs no second list.
 */
import { API_ROUTES } from '@indx-workspace/contracts/routes';

import { pathPattern } from './api-key-routes';

const AGENT_ENDPOINT_ROUTES = API_ROUTES.filter(
  (route) => route.security === 'endpoint-credential',
).map((route) => ({ method: route.method, pattern: pathPattern(route.path) }));

/** Whether `method` on `pathname` is exactly one of the endpoint-credential catalogue routes. */
export function isAgentEndpointRoute(method: string, pathname: string): boolean {
  const effective = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return AGENT_ENDPOINT_ROUTES.some(
    (route) => route.method === effective && route.pattern.test(pathname),
  );
}
