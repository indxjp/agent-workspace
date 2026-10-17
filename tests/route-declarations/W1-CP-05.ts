/**
 * W1-CP-05 · agent CRUD · spec §34, the five agent routes and no more.
 *
 * Converted out of `tests/route-inventory.test.ts`'s `EXPECTED_ROUTES` array by W2-INT-00, which is
 * [ADR-0025](../../docs/adr/0025-the-route-inventory-is-partitioned-by-owner.md) §4: the partition
 * is first exercised by the two tasks it was built for, because *"a partition scheme first exercised
 * by the tasks it was built for has been tested by nobody"*.
 *
 * All five are printed verbatim in spec §34, so none carries a `mandate` — and under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2 adding one here would *fail* the gate, because it would mean the author did not know
 * the route was already named.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  { method: 'POST', path: '/api/agents', owner: 'W1-CP-05', landed: true },
  { method: 'GET', path: '/api/agents', owner: 'W1-CP-05', landed: true },
  { method: 'GET', path: '/api/agents/:id', owner: 'W1-CP-05', landed: true },
  { method: 'PATCH', path: '/api/agents/:id', owner: 'W1-CP-05', landed: true },
  { method: 'DELETE', path: '/api/agents/:id', owner: 'W1-CP-05', landed: true },
  {
    method: 'GET',
    path: '/api/agents/:id/resources',
    owner: 'W1-CP-05',
    landed: true,
    mandate: {
      section: '17',
      because:
        'spec §17 Step 3 assigns files, skills, and connectors to an agent and requires the saved selection to be readable when the editor is reopened.',
    },
  },
  {
    method: 'PUT',
    path: '/api/agents/:id/resources',
    owner: 'W1-CP-05',
    landed: true,
    mandate: {
      section: '17',
      because:
        'spec §17 Step 3 requires one atomic save operation for an agent resource selection, including file access modes.',
    },
  },
];
