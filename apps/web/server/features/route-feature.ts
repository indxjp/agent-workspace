/**
 * Which feature (ADR-0160 D2) a request's route belongs to, derived from the contracts' route
 * catalogue so a route added there is covered with no second list to update.
 */
import type { RouteFeature } from '@indx-workspace/contracts/features';
import { API_ROUTE_EXCLUSIONS, API_ROUTES } from '@indx-workspace/contracts/routes';

import { pathPattern, routeMethod } from '../auth/api-key-routes';

interface FeatureMatcher {
  readonly method: string;
  readonly pattern: RegExp;
  readonly params: number;
  readonly feature: RouteFeature;
}

const MATCHERS: readonly FeatureMatcher[] = [...API_ROUTES, ...API_ROUTE_EXCLUSIONS].map(
  (route) => ({
    method: route.method,
    pattern: pathPattern(route.path),
    params: route.path.split('/').filter((segment) => segment.startsWith(':')).length,
    feature: route.feature,
  }),
);

/**
 * The feature of `method` on `pathname`, or `null` for a path no catalogued route serves. A literal
 * segment beats a `:param` one, as the router resolves them.
 */
export function routeFeatureOf(method: string, pathname: string): RouteFeature | null {
  const effective = routeMethod(method);
  let best: FeatureMatcher | null = null;
  for (const matcher of MATCHERS) {
    if (matcher.method !== effective || !matcher.pattern.test(pathname)) continue;
    if (best === null || matcher.params < best.params) best = matcher;
  }
  return best === null ? null : best.feature;
}
