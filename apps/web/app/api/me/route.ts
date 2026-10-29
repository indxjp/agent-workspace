/**
 * `GET /api/me` — the principal the presented credential resolves to, and no other verb.
 *
 * Issue #233 (SDK-01). This is every consumer's first call: an API key is bound to one workspace
 * and, until this route existed, had no way to name it, its role or its principal id; a session
 * caller additionally learns its `userId` and a human label.
 *
 * Deliberately trivial, like the other route files of this task: `authorise` is the first and only
 * gate, and the projection behind it is `readMe` in `apps/web/server/rbac/handlers.ts`, which a
 * test imports without the framework. The imports are relative rather than `@/…` for the reason
 * `apps/web/app/api/users/route.ts` records — the alias is a bundler setting Vitest does not
 * resolve for this workspace member, and a route file no test can import is a route whose wiring
 * is an untested claim.
 *
 * The ownership argument is `not-applicable`, and it is the honest answer rather than a
 * convenience: this route names no row. A principal is a singleton per caller, so there is no
 * other member's principal it could be asked for and no `:id` to conceal — which is why the
 * concealment property the `/api/memberships/:id` and `/api/api-keys/:id` routes carry has no
 * counterpart here, stated rather than quietly omitted (ADR-0031).
 */
import { readMe } from '../../../server/rbac/handlers';
import { authorise, toResponse } from '../../../server/rbac/http';

// The repository-wide route invariant (`tests/route-inventory.test.ts`): every route runs on the
// Node runtime and none is prerendered. Correct here independently of the gate — this handler
// reads the session cookie or the bearer key through `authorise`.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** `GET /api/me` — who this credential is, for both principal kinds spec §21 distinguishes. */
export async function GET(request: Request): Promise<Response> {
  const result = await authorise(request, 'not-applicable', ({ principal, features }) =>
    Promise.resolve(readMe(principal, features)),
  );
  return toResponse(result);
}
