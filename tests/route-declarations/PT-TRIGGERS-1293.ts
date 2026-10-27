/**
 * PT-TRIGGERS-1293 · `/api/triggers` — issue #1293, ADR-0144.
 *
 * Spec §34's "Examples:" list does not print these routes, so each carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2. Each `because` is an inline quoted string: `declarationArrayToJson` refuses `+` and constants. The fire
 * route is public: the secret in its path is its authentication, and the proxy exempts exactly it.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/triggers',
    owner: 'PT-TRIGGERS-1293',
    landed: true,
    mandate: {
      section: '22',
      because:
        'spec §22 has the workspace provide credentials for programmatic access, and ADR-0144 lets an external system start a run of one agent through a trigger URL whose secret is that credential, so managing triggers is credential-bearing configuration.',
    },
  },
  {
    method: 'POST',
    path: '/api/triggers',
    owner: 'PT-TRIGGERS-1293',
    landed: true,
    mandate: {
      section: '22',
      because:
        'spec §22 has the workspace provide credentials for programmatic access, and ADR-0144 lets an external system start a run of one agent through a trigger URL whose secret is that credential, so managing triggers is credential-bearing configuration.',
    },
  },
  {
    method: 'GET',
    path: '/api/triggers/:id',
    owner: 'PT-TRIGGERS-1293',
    landed: true,
    mandate: {
      section: '22',
      because:
        'spec §22 has the workspace provide credentials for programmatic access, and ADR-0144 lets an external system start a run of one agent through a trigger URL whose secret is that credential, so managing triggers is credential-bearing configuration.',
    },
  },
  {
    method: 'PATCH',
    path: '/api/triggers/:id',
    owner: 'PT-TRIGGERS-1293',
    landed: true,
    mandate: {
      section: '22',
      because:
        'spec §22 has the workspace provide credentials for programmatic access, and ADR-0144 lets an external system start a run of one agent through a trigger URL whose secret is that credential, so managing triggers is credential-bearing configuration.',
    },
  },
  {
    method: 'DELETE',
    path: '/api/triggers/:id',
    owner: 'PT-TRIGGERS-1293',
    landed: true,
    mandate: {
      section: '22',
      because:
        'spec §22 has the workspace provide credentials for programmatic access, and ADR-0144 lets an external system start a run of one agent through a trigger URL whose secret is that credential, so managing triggers is credential-bearing configuration.',
    },
  },
  {
    method: 'POST',
    path: '/api/triggers/:id/secret',
    owner: 'PT-TRIGGERS-1293',
    landed: true,
    mandate: {
      section: '22',
      because:
        'spec §22 has the workspace provide credentials for programmatic access, and ADR-0144 lets an external system start a run of one agent through a trigger URL whose secret is that credential, so managing triggers is credential-bearing configuration.',
    },
  },
  {
    method: 'POST',
    path: '/api/triggers/:id/fire/:secret',
    owner: 'PT-TRIGGERS-1293',
    landed: true,
    mandate: {
      section: '22',
      because:
        'spec §22 has the workspace provide credentials for programmatic access, and ADR-0144 makes the secret in a trigger fire URL the whole authentication of the ingress, because Microsoft Graph and Zoom can call only a fixed URL and send no header.',
    },
  },
  {
    method: 'GET',
    path: '/api/cron/triggers',
    owner: 'PT-TRIGGERS-1293',
    landed: true,
    mandate: {
      section: '22',
      because:
        'ADR-0144 lets a schedule trigger start a run of one agent at its cron time; on a platform with no long-lived process the schedule pass is a cron call authenticated by CRON_SECRET.',
    },
  },
];
