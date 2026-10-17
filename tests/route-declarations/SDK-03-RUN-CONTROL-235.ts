/**
 * SDK-03-RUN-CONTROL-235 · `POST /api/runs/:id/interrupt` (S-14) and
 * `POST /api/runs/:id/revoke-tokens` (S-15) — issue #235.
 *
 * Spec §34's "Examples:" list does not print either path, so both carry a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2 — the same section, §24, `tests/route-declarations/W1-CP-04.ts`'s
 * `POST /api/runs/:id` already cites for the same capability under its old, undifferentiated name.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/runs/:id/interrupt',
    owner: 'SDK-03-RUN-CONTROL-235',
    landed: true,
    mandate: {
      section: '24',
      because:
        'spec §24 requires the control plane to enforce the gateway security boundary; stopping a run makes it terminal and revokes its registered token even when the runtime itself cannot be reached, exactly the boundary the credential-lifetime timer already enforces.',
    },
  },
  {
    method: 'POST',
    path: '/api/runs/:id/revoke-tokens',
    owner: 'SDK-03-RUN-CONTROL-235',
    landed: true,
    mandate: {
      section: '24',
      because:
        'the named successor of POST /api/runs/:id (W1-CP-04): spec §24 requires the control plane to enforce the gateway security boundary, and this is the same owner/admin-only revocation under a path that says what it does.',
    },
  },
];
