/**
 * `GET`, `PATCH` and `DELETE` on `/api/agents/:id` — three of the five agent routes of spec §34.
 *
 * `POST /api/agents/:id/runs` is **not** here. It is a different route, owned by W1-CP-04, and it
 * lives in `[id]/runs/route.ts`; see ADR-0013 for the Wave 1 ownership split.
 *
 * The imports are relative, not `@/…`, so that a Vitest test can import this file — see the note
 * in `../route.ts` and `apps/web/server/agents/routes.test.ts`.
 */
import type { UpdateAgentPatch } from '../../../../contracts/agents';
import {
  agentNotFound,
  deleteAgent,
  getAgent,
  updateAgent,
  type ApiResult,
} from '../../../../server/agents/handlers';
import { saveConsoleEdit } from '../../../../server/agent-versions/http';
import { judgeAgent } from '../../../../server/policy-ceiling/ceiling';
import { isUuid, parseRuntimeProfileId } from '../../../../server/agents/contract';
import {
  readAgentIdParam,
  readJsonBody,
  toResponse,
  withAuthorisedWorkspaceStore,
} from '../../../../server/agents/http';
import { resolverForRow } from '../../../../server/resources/item-ownership';
import type { WorkspaceAgentStore } from '../../../../server/agents/store';
import type { OwnershipResolver } from '../../../../server/rbac/http';

/**
 * Issue #117: load the agent within the caller's workspace, answer an indistinguishable 404 when
 * it is absent, and only then let `decide()` compare `created_by` against the caller.
 */
function ownershipOf(id: unknown): (store: WorkspaceAgentStore) => OwnershipResolver {
  return (store) =>
    resolverForRow(
      // `isUuid`, not merely `typeof id === 'string'`: `agents.id` is a `uuid` column, and a
      // non-UUID string handed to `store.get` would reach PostgreSQL as an invalid literal and
      // throw, rather than answering "not found" the way this resolver promises to.
      () => (isUuid(id) ? store.get(id) : Promise.resolve(null)),
      agentNotFound,
    );
}

// The repository-wide route invariant (`tests/route-inventory.test.ts`, "runs every route on the
// Node runtime and never prerenders one"). Added by W1-INT-02, for the reason given at the same
// place in `../route.ts`.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Next 15+ resolves a dynamic segment asynchronously, so `params` is a promise. */
type AgentRouteContext = { params: Promise<{ id: string }> };

/** `GET /api/agents/:id` — 404 for an id this workspace does not have, never 403 (§25). */
export async function GET(request: Request, context: AgentRouteContext): Promise<Response> {
  const id = await readAgentIdParam(context);
  const result = await withAuthorisedWorkspaceStore(request, ownershipOf(id), (store) =>
    getAgent(store, id),
  );
  return toResponse(result);
}

/**
 * `PATCH /api/agents/:id` — apply a partial update to one agent in the caller's workspace.
 *
 * The body is read *inside* `withWorkspaceStore` so that the workspace gate runs before anything
 * the caller sent is parsed. See the note on `POST /api/agents` in `../route.ts`: a caller who
 * fails the gate must not learn this route's body format, and once W1-CP-06 wires a session the
 * other order would answer `400` where it owes `401`.
 */
export async function PATCH(request: Request, context: AgentRouteContext): Promise<Response> {
  const id = await readAgentIdParam(context);
  const result = await withAuthorisedWorkspaceStore(
    request,
    ownershipOf(id),
    async (store, runtime, workspaceId, principal) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.result;
      // Issue #535: the patch merged over the agent as stored, with its stored policy and its
      // current connectors, is judged against the deployment's ceiling before it is written.
      // ponytail: check-then-write race until V-2, same as SD11
      const ceiling = runtime.ceilingFor?.(request, workspaceId) ?? null;
      const judge = async (patch: UpdateAgentPatch): Promise<ApiResult | null> => {
        if (ceiling === null || !isUuid(id)) return null;
        const current = await store.get(id);
        if (current === null) return null;
        const assignments = await runtime.agentResources?.forWorkspace(workspaceId).get(id);
        const next = { ...current, ...patch };
        return judgeAgent(next, assignments?.connectorIds ?? [], ceiling, {
          id,
          label: next.name,
        });
      };
      // Issue #616: a console edit is saved as a version (`via: 'ui'`) and `local` points at it.
      const write = async (patch: UpdateAgentPatch): Promise<ApiResult | null> => {
        const current = isUuid(id) ? await store.get(id) : null;
        if (current === null) return agentNotFound();
        return saveConsoleEdit(current, { kind: 'patch', patch }, principal, ceiling);
      };
      const record =
        typeof body.value === 'object' && body.value !== null && !Array.isArray(body.value)
          ? (body.value as Record<string, unknown>)
          : null;
      const carriesRuntimeProfile =
        record !== null && Object.prototype.hasOwnProperty.call(record, 'runtimeProfileId');
      if (!carriesRuntimeProfile || typeof id !== 'string') {
        return updateAgent(store, id, body.value, judge, write);
      }

      const requested = parseRuntimeProfileId(record['runtimeProfileId']);
      if (!requested.ok) return updateAgent(store, id, body.value, judge, write);
      const before = await store.get(id);
      if (before === null || before.runtimeProfileId === requested.value) {
        return updateAgent(store, id, body.value, judge, write);
      }
      if (runtime.runtimeSwitchAudit === undefined) {
        return {
          status: 503,
          body: {
            error: {
              code: 'runtime_switch_audit_not_configured',
              message: 'Runtime switches are disabled until the §36 audit sink is configured.',
            },
          },
        };
      }

      const updated = await updateAgent(store, id, body.value, judge, write);
      if (updated.status === 200) {
        await runtime.runtimeSwitchAudit.record(request, {
          agentId: before.id,
          agentName: before.name,
          fromRuntimeProfileId: before.runtimeProfileId,
          toRuntimeProfileId: requested.value,
        });
      }
      return updated;
    },
  );
  return toResponse(result);
}

/** `DELETE /api/agents/:id` — 204 on success, 404 if the workspace has no such agent. */
export async function DELETE(request: Request, context: AgentRouteContext): Promise<Response> {
  const id = await readAgentIdParam(context);
  const result = await withAuthorisedWorkspaceStore(request, ownershipOf(id), (store) =>
    deleteAgent(store, id),
  );
  return toResponse(result);
}
