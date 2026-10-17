/**
 * SDK-02-AGENT-POLICY-234 · `GET`/`PUT /api/agents/:id/policy` (S-13) — issue #234, spec §17 Step 4.
 *
 * Spec §34's "Examples:" list does not print either route, so both carry a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2. §17 Step 4 is what makes an agent's tool, skill and limit policy part of its
 * definition at all, and until this unit no route could read or replace it — it existed only as a
 * server-side compile step (`apps/web/server/compose/run-request.ts`).
 *
 * The `because` on each mandate is one quoted string, not a concatenated one:
 * `tests/inventory-support.ts`'s `declarationArrayToJson` reads a declaration file as plain data
 * and refuses any expression, `+` included.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/agents/:id/policy',
    owner: 'SDK-02-AGENT-POLICY-234',
    landed: true,
    mandate: {
      section: '17',
      because:
        'spec §17 Step 4 makes tool, skill and limit policy part of the agent definition, and the definition must be readable when the editor is reopened, exactly as W1-CP-05 already made resource assignments readable.',
    },
  },
  {
    method: 'PUT',
    path: '/api/agents/:id/policy',
    owner: 'SDK-02-AGENT-POLICY-234',
    landed: true,
    mandate: {
      section: '17',
      because:
        'spec §17 Step 4 requires the saved policy to be replaceable as one operation, the same shape W1-CP-05 gave resource assignments, so the SDK and CLI can author a policy in a single call.',
    },
  },
];
