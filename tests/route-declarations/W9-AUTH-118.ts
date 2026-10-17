/**
 * W9-AUTH-118 · identity-aware sessions — issue #118, spec §21.
 *
 * All three are pre-session endpoints: `GET /api/auth/login` and `POST /api/auth/callback` are
 * the OIDC authorization-code exchange, moved out of
 * `apps/web/app/p/[token]/messages/route.ts`; `POST /api/auth/workspace` mints or switches the
 * tenant session after re-reading membership. None of the three is printed in spec §34, so each
 * carries a mandate; the shape exception that lets `/api/auth/*` through `routeShape` at all lives
 * in `tests/route-inventory.test.ts` itself, next to the pre-existing `/api/setup` exception it
 * copies.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/auth/login',
    owner: 'W9-AUTH-118',
    landed: true,
    mandate: {
      section: '21',
      because: 'Section 21 requires generic OIDC for enterprise SSO; this begins that exchange.',
    },
  },
  {
    method: 'POST',
    path: '/api/auth/callback',
    owner: 'W9-AUTH-118',
    landed: true,
    mandate: {
      section: '21',
      because:
        'The OIDC exchange completes here, resolving the identity a membership row (section 21) can be read for.',
    },
  },
  {
    method: 'GET',
    path: '/api/auth/workspace',
    owner: 'W9-AUTH-118',
    landed: true,
    mandate: {
      section: '21',
      because:
        'The minimal selection step: a user with more than one membership (section 21) needs the list before picking one.',
    },
  },
  {
    method: 'POST',
    path: '/api/auth/workspace',
    owner: 'W9-AUTH-118',
    landed: true,
    mandate: {
      section: '21',
      because:
        'A user belongs to a workspace with one of four roles (section 21); this is where one with several picks which.',
    },
  },
];
