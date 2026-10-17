/**
 * SDK-01-ME-233 · `GET /api/me`, the route every consumer calls first — issue #233, spec §21.
 *
 * Spec §34's "Examples:" list does not print it, so it carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2, checked against `docs/spec.md`'s own headings by `tests/route-inventory.test.ts` so
 * the citation cannot be invented. §21 is the section: it is what makes a workspace-local identity
 * with one of four roles a thing at all, and the role this route reports is the one §21's
 * permission split is applied to on every other request.
 *
 * `me` is singular where §34's shape rule wants a plural resource, which is why
 * `tests/route-inventory.test.ts`'s `routeShape` carries a named exception for this one literal
 * path — see that function for the reasoning, and the two exceptions of the same form that
 * preceded it.
 *
 * The `because` is one quoted string, not a concatenated one: `tests/inventory-support.ts`'s
 * `declarationArrayToJson` reads a declaration file as plain data and refuses any expression, `+`
 * included, as a construct it cannot read.
 *
 * This same entry is what `apps/web/server/rbac/authorisation-matrix.test.ts` crosses with §21's
 * four roles and every ownership answer. It is not in that file's `IDENTITY_ONLY_ROUTES`: that set
 * is for callers who have no workspace `Principal` at all, and a `me` caller by definition has
 * one. `apps/web/server/rbac/permissions.ts` classifies `me` as read-only for every role.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/me',
    owner: 'SDK-01-ME-233',
    landed: true,
    mandate: {
      section: '21',
      because:
        "Section 21 gives every caller a workspace-local identity and one of four roles, and every other route's answer is decided against them; without this route a caller — an API key above all, which is bound to one workspace and carries no membership to list — has no way to read back the workspace, role and principal id it was authorised under.",
    },
  },
];
