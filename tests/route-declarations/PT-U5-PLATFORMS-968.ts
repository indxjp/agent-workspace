/**
 * PT-U5-PLATFORMS-968 · `GET /api/platforms`, `POST /api/agents/:id/platform-exports` and
 * `POST /api/agents/:id/platform-archives` — issue #968, ADR-0133.
 *
 * Spec §34's "Examples:" list prints none of the three, so each carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2. §12 makes an agent portable across hosts, and ADR-0133 makes exporting one saved
 * version to a platform target the way it leaves.
 *
 * The `because` on each mandate is one quoted string: `tests/inventory-support.ts` reads a
 * declaration file as plain data and refuses any expression.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/platforms',
    owner: 'PT-U5-PLATFORMS-968',
    landed: true,
    mandate: {
      section: '12',
      because:
        'spec §12 makes an agent portable across hosts, and ADR-0133 makes the platform targets a fixed catalogue, so a client must be able to read which targets this deployment can export to.',
    },
  },
  {
    method: 'POST',
    path: '/api/agents/:id/platform-exports',
    owner: 'PT-U5-PLATFORMS-968',
    landed: true,
    mandate: {
      section: '12',
      because:
        'spec §12 makes an agent portable across hosts, and ADR-0133 makes one saved version compile to a platform target with a verdict for every field, answered as files and a report.',
    },
  },
  {
    method: 'POST',
    path: '/api/agents/:id/platform-archives',
    owner: 'PT-U5-PLATFORMS-968',
    landed: true,
    mandate: {
      section: '12',
      because:
        'spec §12 makes an agent portable across hosts, and the same export as one tar is what a person unpacks into a platform without decoding JSON files.',
    },
  },
];
