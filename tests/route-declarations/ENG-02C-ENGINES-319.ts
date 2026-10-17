/**
 * ENG-02C-ENGINES-319 · `GET /api/engines`, the engine catalogue a deployment offers — issue #319
 * (ENG-02c), spec §5, ADR-0065.
 *
 * Spec §34's "Examples:" list does not print it, so it carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2, checked against `docs/spec.md`'s own headings by `tests/route-inventory.test.ts` so
 * the citation cannot be invented. §5 is the section: it is what makes the engine an extension
 * point behind one port rather than a fixed dependency, and a client that may pick an engine must
 * be able to read which ones this deployment installs.
 *
 * The `because` is one quoted string, not a concatenated one: `tests/inventory-support.ts`'s
 * `declarationArrayToJson` reads a declaration file as plain data and refuses any expression, `+`
 * included, as a construct it cannot read.
 *
 * This same entry is what `apps/web/server/rbac/authorisation-matrix.test.ts` crosses with §21's
 * four roles and every ownership answer; `apps/web/server/rbac/permissions.ts` classifies
 * `engines` as read-only for every role.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/engines',
    owner: 'ENG-02C-ENGINES-319',
    landed: true,
    mandate: {
      section: '5',
      because:
        'Section 5 makes the engine that runs the agent loop an extension point behind one port (ADR-0065) rather than a fixed dependency, so which engines a deployment installs is a property of the deployment; without this route a client choosing an agent policy arm has to guess it, and a typed refusal of an engine the deployment does not register would be the first time it found out.',
    },
  },
];
