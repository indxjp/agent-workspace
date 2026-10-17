/**
 * W2-CP-05 · MCP connectors, credentials referenced from secrets, Test Connection — spec §8, §34.
 *
 * `GET`/`POST /api/connectors` are printed verbatim in spec §34, so neither carries a `mandate`
 * (ADR-0026 decision 2). The wizard's pre-save `[ Test Connection ]` button (spec §8) rides
 * `POST /api/connectors` itself — a `"dryRun": true` field on the same body runs the probe instead
 * of persisting a row — rather than a route of its own: `/api/connectors/test-connection` is a
 * literal second path segment with no id before it, which
 * `tests/route-inventory.test.ts`'s shape rule (ADR-0026 decision 3) refuses as "a second resource
 * that has not been named" the moment it carries a `mandate`, and declaring a genuinely new
 * top-level resource means writing four roles' grants into `apps/web/server/rbac/permissions.ts`
 * — W2-CP-06's file, not this task's to add a resource to. See `apps/web/server/connectors/handlers.ts`'s
 * header for the full reasoning.
 *
 * `GET`/`DELETE /api/connectors/:id` and `POST /api/connectors/:id/test-connection` are not in
 * §34's list at all — only the bare collection routes are — so each cites §8.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  { method: 'GET', path: '/api/connectors', owner: 'W2-CP-05', landed: true },
  { method: 'POST', path: '/api/connectors', owner: 'W2-CP-05', landed: true },
  {
    method: 'GET',
    path: '/api/connectors/:id',
    owner: 'W2-CP-05',
    landed: true,
    mandate: {
      section: '8',
      because:
        "spec §8 draws one row per connector; a workspace needs to read one connector's current configuration to edit or inspect it, and §34 prints only bare GET/POST /api/connectors.",
    },
  },
  {
    method: 'DELETE',
    path: '/api/connectors/:id',
    owner: 'W2-CP-05',
    landed: true,
    mandate: {
      section: '8',
      because:
        'a connector wizard that can create a connector needs a way to remove one; §34 prints only bare GET/POST /api/connectors.',
    },
  },
  {
    method: 'PATCH',
    path: '/api/connectors/:id',
    owner: 'W2-CP-05',
    landed: true,
    mandate: {
      section: '8',
      because:
        'connector credentials must be rotatable in place without returning the prior or replacement secret value.',
    },
  },
  {
    method: 'POST',
    path: '/api/connectors/:id/test-connection',
    owner: 'W2-CP-05',
    landed: true,
    mandate: {
      section: '8',
      because:
        'spec §8\'s "[ Test Connection ]" button, run again against an already-saved connector (e.g. to re-check one whose credential rotated) — resolving the stored secret reference server-side rather than asking the caller to resend the credential.',
    },
  },
];
