import { BUILDER_CATALOG_KINDS } from '@indx-workspace/contracts/builder';

import { decide } from '../../../rbac/decide';
import type { Role } from '../../../rbac/roles';
import type { CatalogKind } from '../../ports';

/** The console route each listed kind is read from; RBAC answers for the route, so the catalog agrees with the console. */
const ROUTES = {
  engines: '/api/engines',
  models: '/api/model-connections',
  skills: '/api/skills',
  connectors: '/api/connectors',
  runtimeProfiles: '/api/runtime-profiles',
} as const satisfies Partial<Record<CatalogKind, string>>;

// ponytail: `files` has no server list handler yet (the listing is inline in app/api/files/route.ts), so it is never listed.
export type ListedKind = keyof typeof ROUTES;

function isListed(kind: CatalogKind): kind is ListedKind {
  return kind in ROUTES;
}

/** The kinds among `wanted` that `role` may read, in `BUILDER_CATALOG_KINDS` order. */
export function readableKinds(role: Role, wanted: readonly CatalogKind[]): ListedKind[] {
  return BUILDER_CATALOG_KINDS.filter(isListed).filter(
    (kind) =>
      wanted.includes(kind) &&
      decide({ role, method: 'GET', path: ROUTES[kind], ownership: 'not-applicable', scope: null })
        .effect === 'allow',
  );
}
