/**
 * W2-CP-06 · users, memberships and API keys — spec §21 and §22.
 *
 * Two of these nine routes are printed verbatim in spec §34 (`GET /api/users`, `POST /api/users`)
 * and therefore carry no `mandate`: under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2, a mandate on a route §34 already prints *fails* the gate, because it means the
 * author did not know it was already named.
 *
 * The other seven are §34's "Examples:" being a shape rule rather than a closed list. Each cites
 * the section that requires the capability, and `tests/route-inventory.test.ts` looks that section
 * up in `docs/spec.md`'s headings, so none of these citations can be invented.
 *
 * These same entries are what `apps/web/server/rbac/authorisation-matrix.test.ts` crosses with
 * §21's four roles — along with every other task's declarations, which is the point: the matrix is
 * the union of this directory, so it covers a route another track adds the moment that route is
 * committed.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  { method: 'GET', path: '/api/users', owner: 'W2-CP-06', landed: true },
  { method: 'POST', path: '/api/users', owner: 'W2-CP-06', landed: true },
  {
    method: 'GET',
    path: '/api/memberships',
    owner: 'W2-CP-06',
    landed: true,
    mandate: {
      section: '21',
      because: 'Users belong to a workspace with one of four roles; a membership is that fact.',
    },
  },
  {
    method: 'POST',
    path: '/api/memberships',
    owner: 'W2-CP-06',
    landed: true,
    mandate: {
      section: '21',
      because: 'Attaching a user to a workspace with a role is how §21 grants any permission.',
    },
  },
  {
    method: 'PATCH',
    path: '/api/memberships/:id',
    owner: 'W2-CP-06',
    landed: true,
    mandate: {
      section: '21',
      because:
        'Four roles are not an authorisation model without a way to move a member between them.',
    },
  },
  {
    method: 'DELETE',
    path: '/api/memberships/:id',
    owner: 'W2-CP-06',
    landed: true,
    mandate: {
      section: '21',
      because: 'A member who has left must stop being a member, and §21 has no other mechanism.',
    },
  },
  {
    method: 'GET',
    path: '/api/api-keys',
    owner: 'W2-CP-06',
    landed: true,
    mandate: {
      section: '22',
      because: 'Section 22 prints the API Keys list screen: name, masked prefix, last used.',
    },
  },
  {
    method: 'POST',
    path: '/api/api-keys',
    owner: 'W2-CP-06',
    landed: true,
    mandate: {
      section: '22',
      because: 'Section 22 prints "+ Create API Key", and this is the only route that returns one.',
    },
  },
  {
    method: 'DELETE',
    path: '/api/api-keys/:id',
    owner: 'W2-CP-06',
    landed: true,
    mandate: {
      section: '22',
      because: 'Section 22 lists revoked_at, so a key must be revocable; it writes, not deletes.',
    },
  },
];
