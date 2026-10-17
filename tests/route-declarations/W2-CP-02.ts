/**
 * W2-CP-02 · secrets: envelope encryption in PostgreSQL under a deployment master key, write-only
 * API — spec §23, §26.
 *
 * None of these three is printed in spec §34's example list (§34's own introduction is
 * "Examples:", and the Wave 2a manifest records §34 omitting secrets entirely), so each
 * carries a `mandate` per [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md).
 *
 * There is deliberately no `GET /api/secrets/:id` here — §23's write-only rule means no route on
 * this resource returns a value. `DELETE /api/secrets/:id` was this task's declared gap; issue #240
 * (S-10) closed it, and declares it here so the secrets resource keeps one declaration file that
 * `apps/web/server/secrets/no-plaintext-leak.test.ts` drives in full.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/secrets',
    owner: 'W2-CP-02',
    landed: true,
    mandate: {
      section: '23',
      because: '"Provide a central secrets layer" for provider credentials and other values.',
    },
  },
  {
    method: 'GET',
    path: '/api/secrets',
    owner: 'W2-CP-02',
    landed: true,
    mandate: {
      section: '23',
      because:
        'A central secrets layer needs a way to see which secrets exist without exposing their values — the write-only API this section requires.',
    },
  },
  {
    method: 'PUT',
    path: '/api/secrets/:id',
    owner: 'W2-CP-02',
    landed: true,
    mandate: {
      section: '23',
      because:
        'A credential that never rotates is not a credential a deployment can recover from a leak of; replacing a secret value is part of providing a central secrets layer.',
    },
  },
  {
    method: 'DELETE',
    path: '/api/secrets/:id',
    owner: 'W2-CP-02',
    landed: true,
    mandate: {
      section: '23',
      because:
        'A central secrets layer must be able to retire a credential; the delete is refused while a connector or model connection still references it, so no referrer is silently orphaned (issue #240).',
    },
  },
];
