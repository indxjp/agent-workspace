/**
 * `POST /api/connectors` and `GET /api/connectors` — spec §8, §34. Both are printed in spec §34's
 * example list verbatim, so neither carries a `mandate`.
 *
 * Imports are relative, not `@/…`, for the reason `apps/web/app/api/agents/route.ts`'s header
 * gives: the alias is a bundler setting Vitest does not resolve, and a relative specifier is what
 * lets `routes.test.ts` exercise this file directly.
 */
import { createConnector, isDryRunBody, listConnectors } from '../../../server/connectors/handlers';
import { problem } from '../../../server/http/result';
import { readConnectorBody, withWorkspaceStore } from '../../../server/connectors/http';
import { apiResultResponse } from '../../../server/http/json-transport';
import { requireResourceAccess } from '../../../server/resources/authorise';

// The repository-wide route invariant (`tests/route-inventory.test.ts`): every route runs on the
// Node runtime and is never prerendered. These handlers read the session cookie through
// `withWorkspaceStore`, so prerendering is never correct, and `edge` cannot hold what the runtime
// wiring needs — `pg` and `node:crypto`, neither available there.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Issue #388: both methods are gated by the shared decision table first, as the `:id` routes
// already were. §21: Owner all, Admin manage, Builder reads any and writes its own, Viewer none
// (`permissions.ts`). `withWorkspaceStore`'s own resolution answers only "which workspace".

/** `GET /api/connectors` — this workspace's connectors, and no other workspace's (§25). */
export async function GET(request: Request): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const result = await withWorkspaceStore(
    request,
    (store) => listConnectors(store),
    access.principal.workspaceId,
  );
  return apiResultResponse(result);
}

/**
 * `POST /api/connectors` — create one connector in the caller's workspace.
 *
 * The body is read *inside* `withWorkspaceStore`, so the workspace gate runs first — a caller who
 * fails the gate must not learn this route's body format.
 */
export async function POST(request: Request): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const result = await withWorkspaceStore(
    request,
    async (store, audit) => {
      const body = await readConnectorBody(request);
      if (!body.ok) return body.result;

      // A dry run never persists a row, so it needs no `created_by` — read it straight away, before
      // identifying anyone: the probe runs for a caller who never intends to save a connector.
      if (isDryRunBody(body.value)) {
        return createConnector(store, body.value, null);
      }

      // Issue #117: every create path stamps `created_by` in the same request that inserts the row.
      // `identifyActor` is the same identity `recordAudit` below already requires an actor to have —
      // refusing here is a 401 the caller can act on, in place of the 500 `recordAudit` would throw
      // after the row was already written.
      const actor = await audit.identifyActor();
      if (actor === null) {
        return problem(
          401,
          'unauthenticated',
          'Creating a connector requires a verified session; an API key has no individual member ' +
            'to attribute the row to.',
        );
      }
      const created = await createConnector(store, body.value, actor);
      if (created.status === 201) {
        const connector = created.body as { id: string; name: string };
        await audit.recordAudit({ subjectId: connector.id, subjectLabel: connector.name });
      }
      return created;
    },
    access.principal.workspaceId,
  );
  return apiResultResponse(result);
}
