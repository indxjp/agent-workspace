/**
 * W9-WS-119 · workspace CRUD/listing APIs with transactional owner membership — issue #119, spec
 * §21 and §27.
 *
 * None of these four is printed by spec §34's "Examples:" list, so each carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2, checked against `docs/spec.md`'s own headings by `tests/route-inventory.test.ts` so
 * the citation cannot be invented.
 *
 * Each `because` is one quoted string, not a concatenated one: `tests/inventory-support.ts`'s
 * `declarationArrayToJson` reads a declaration file as plain data — quoted strings, numbers,
 * booleans, objects and arrays — and refuses any expression, `+` included, as a construct it
 * cannot read (verified against this very file, which used to concatenate and failed
 * `authorisation-matrix.test.ts`/`routes.test.ts` with exactly that message).
 *
 * `GET /api/workspaces` is the identity-scoped listing the card names explicitly: unlike every
 * other route this repository has declared before it, its result set is not "every row of one
 * resource in the caller's session workspace" — it is every workspace the caller's OWN identity
 * currently belongs to, which is why `apps/web/server/rbac/permissions.ts`'s
 * `WORKSPACE_MEMBER_SCOPED` grant is `own` rather than `any` for every one of §21's four roles
 * (see that constant's own comment for the cross-workspace exploit `any` would open). `POST` shares
 * the same grant width and is available to every role for the identical reason: #119 puts no role
 * gate on who may create a new workspace, only on who may administer one that already exists.
 *
 * These same entries are what `apps/web/server/rbac/authorisation-matrix.test.ts` crosses with
 * §21's four roles and every ownership answer, the same union every other task's declarations
 * join.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/workspaces',
    owner: 'W9-WS-119',
    landed: true,
    mandate: {
      section: '21',
      because:
        'Section 21 makes the workspace the one top-level tenancy concept; a user who belongs to more than one needs the identity-scoped list of their own current memberships before picking or administering one (the same need GET /api/auth/workspace answers pre-session for #118; this is its durable, authenticated counterpart).',
    },
  },
  {
    method: 'POST',
    path: '/api/workspaces',
    owner: 'W9-WS-119',
    landed: true,
    mandate: {
      section: '21',
      because:
        "Section 27's minimal database model makes workspaces the tenant root every other row is scoped under; a control plane with no way to create one is a single-tenant deployment wearing a multi-tenant schema.",
    },
  },
  {
    method: 'GET',
    path: '/api/workspaces/:id',
    owner: 'W9-WS-119',
    landed: true,
    mandate: {
      section: '21',
      because:
        "A member of more than one workspace (section 21) needs to read one of their other memberships' details, including whether it is archived, without first switching the active session to it.",
    },
  },
  {
    method: 'PATCH',
    path: '/api/workspaces/:id',
    owner: 'W9-WS-119',
    landed: true,
    mandate: {
      section: '21',
      because:
        "Section 21 gives Owner Everything, including, as issue #119 makes explicit, renaming and archiving the workspace itself; no other route offers a way to change a workspace's own name or lifecycle state.",
    },
  },
];
