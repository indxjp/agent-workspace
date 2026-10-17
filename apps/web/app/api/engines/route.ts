/**
 * `GET /api/engines` — the engines this deployment offers, and no other verb (ENG-02c, #319).
 *
 * The catalogue is deployment configuration, not workspace data: every engine it lists is the same
 * for every caller, which is why `authorise` is handed `'not-applicable'` — there is no row here to
 * own. What the gate still decides is that the caller is authenticated and that §21 lets its role
 * read the resource, which the `engines` row of `apps/web/server/rbac/permissions.ts` grants to
 * every workspace member and API key.
 *
 * Deliberately trivial, like `app/api/me/route.ts`: everything worth testing is `listEngines` in
 * `apps/web/server/engines/handlers.ts`, which a test imports with no framework involved. The
 * imports are relative rather than `@/…` because that alias is a bundler setting Vitest does not
 * resolve, and a route file no test can import is a route whose wiring is an untested claim.
 */
import { listEngines } from '../../../server/engines/handlers';
import { authorise, toResponse } from '../../../server/rbac/http';

// The repository-wide route invariant (`tests/route-inventory.test.ts`): every route runs on the
// Node runtime and none is prerendered. Correct here independently of the gate — the answer depends
// on the caller's credential, which `authorise` reads from the request.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** `GET /api/engines` — every registered `EngineDescriptor`, in the catalogue's order. */
export async function GET(request: Request): Promise<Response> {
  return toResponse(
    await authorise(request, 'not-applicable', () => Promise.resolve(listEngines())),
  );
}
