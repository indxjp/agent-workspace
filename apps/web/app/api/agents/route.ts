/**
 * `POST /api/agents` and `GET /api/agents` — two of the five agent routes of spec §34.
 *
 * The other three live in `[id]/route.ts`. Nothing else belongs in this directory: §34 names five
 * agent routes and `tests/route-inventory.test.ts` fails the build if a sixth appears, whether it
 * is a search endpoint, a bulk endpoint or a count endpoint.
 *
 * These functions are deliberately trivial: the create use case is `server/agents/create.ts` (W2-3),
 * and everything worth testing is in `apps/web/server/agents/`, which a test imports without the
 * framework.
 *
 * The imports below are relative rather than `@/…` on purpose. The `@/` alias is a bundler
 * setting: `next build` resolves it and Vitest, which has no Next plugin configured for this
 * workspace member, does not. While these files used the alias they could not be imported by any
 * test in the repository, so "the route wires the handler to the store correctly" was an untested
 * claim. `apps/web/server/agents/routes.test.ts` imports this file and exercises all five routes;
 * a relative specifier is the price of that and it is a small one.
 */
import { createAgent } from '../../../server/agents/create';
import { listAgents } from '../../../server/agents/handlers';
import { withAuthorisedWorkspaceStore } from '../../../server/agents/http';
import type { ApiResult } from '../../../server/http/result';
import { route } from '../../../server/http/route';

// The repository-wide route invariant (`tests/route-inventory.test.ts`, "runs every route on the
// Node runtime and never prerenders one"). Added by W1-INT-02: the assertion was written by
// W1-CP-04 over every file under `app/api` and had never run against this file, because the gate
// carrying it lived on a sibling branch. `force-dynamic` is right here independently of the gate —
// these handlers read the session cookie through `withWorkspaceStore`, so prerendering them is
// never correct — and 'edge' is deprecated and cannot hold a long-lived stream (R-13).
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** `GET /api/agents` — the agents of the caller's workspace, and no other workspace's (§25). */
async function serveGet(request: Request): Promise<ApiResult> {
  return withAuthorisedWorkspaceStore(request, 'not-applicable', (store) => listAgents(store));
}

export const GET = route({ component: 'agents', operation: 'list' }, serveGet);

export const POST = route({ component: 'agents', operation: 'create' }, createAgent);
