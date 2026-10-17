/**
 * `GET /api/metrics` — an **operational** endpoint, not spec §34's product Runs surface.
 *
 * It exposes `apps/web/server/telemetry/runtime.ts`'s process-local, bounded projection of
 * recently observed runs for operators watching one web process. It is not durable, not complete
 * across instances, and it is not what `#135`'s `GET /api/runs` or `#136`'s Runs screen consume —
 * see `docs/adr/W9-PLAN-metrics-is-operational-not-product.md` and this task's own
 * `docs/adr/W9-SEC-116-scope-metrics-projection-by-principal-workspace.md`.
 *
 * Issue #116 found that this route checked only `getSession() !== null` and then returned every
 * workspace's telemetry to any authenticated browser session — a cross-tenant leak of run,
 * agent and workspace identifiers. It now goes through the same `authorise`/`decide` gate every
 * other `/api/` route uses: `metrics` is already a classified resource in `permissions.ts` with a
 * read-only grant for all four roles, so no RBAC table changes with this fix. The handler then
 * filters the projection by `principal.workspaceId` — the workspace `authorise` verified the
 * caller belongs to — and reads no workspace identifier from the request itself (no slug, no
 * header, no query parameter), so a forged one cannot widen what is returned.
 */
import { authorise, toResponse } from '../../../server/rbac/http';
import { recentRunTelemetry } from '../../../server/telemetry/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** `GET /api/metrics` — the caller's own workspace's recent run telemetry, and nothing else. */
export async function GET(request: Request): Promise<Response> {
  const result = await authorise(request, 'not-applicable', ({ principal }) =>
    Promise.resolve({ status: 200, body: { runs: recentRunTelemetry(principal.workspaceId) } }),
  );
  return toResponse(result);
}
