/**
 * W1-CP-04 · the run API and the SSE relay.
 *
 * Converted out of `tests/route-inventory.test.ts`'s `EXPECTED_ROUTES` array by W2-INT-00 —
 * [ADR-0025](../../docs/adr/0025-the-route-inventory-is-partitioned-by-owner.md) §4.
 *
 * `GET /api/runs/:id` is here because W1-INT-02 added it: spec §34 names it and no version of the
 * old array had ever declared it, which the gate's own failure message is what surfaced. The
 * comment that recorded that in the array is preserved here rather than dropped, because the file
 * it was written in no longer holds the entries it describes.
 *
 * All three are printed verbatim in spec §34, so none carries a `mandate` (ADR-0026 decision 2).
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  { method: 'POST', path: '/api/agents/:id/runs', owner: 'W1-CP-04', landed: true },
  { method: 'GET', path: '/api/runs/:id', owner: 'W1-CP-04', landed: true },
  {
    method: 'POST',
    path: '/api/runs/:id',
    owner: 'W1-CP-04',
    landed: true,
    mandate: {
      section: '24',
      because:
        'spec §24 requires the control plane to enforce the gateway security boundary; this owner-only operation revokes one or every active credential for the run. Deprecated by issue #235 (S-15) in favour of POST /api/runs/:id/revoke-tokens, which names the capability; this path is deprecated in a minor, kept unchanged, and removed only in the next major, no earlier than one minor after (ADR-0078 D7).',
    },
  },
  { method: 'GET', path: '/api/runs/:id/events', owner: 'W1-CP-04', landed: true },
];
