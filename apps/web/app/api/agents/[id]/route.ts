/**
 * `GET`, `PATCH` and `DELETE` on `/api/agents/:id` — three of the five agent routes of spec §34.
 *
 * `POST /api/agents/:id/runs` is **not** here. It is a different route, owned by W1-CP-04, and it
 * lives in `[id]/runs/route.ts`; see ADR-0013 for the Wave 1 ownership split.
 *
 * The imports are relative, not `@/…`, so that a Vitest test can import this file — see the note
 * in `../route.ts` and `apps/web/server/agents/routes.test.ts`.
 */
import { UpdateAgentPatchSchema, type UpdateAgentPatch } from '../../../../contracts/agents';
import {
  agentNotFound,
  deleteAgent,
  getAgent,
  updateAgent,
} from '../../../../server/agents/handlers';
import { type ApiResult } from '../../../../server/http/result';
import { saveConsoleEdit } from '../../../../server/agent-versions/http';
import { judgeAgent } from '../../../../server/policy-ceiling/ceiling';
import { builderNameRefusal } from '../../../../server/agents/builder-name';
import { isUuid } from '../../../../server/agents/contract';
import {
  agentOwnership,
  readAgentIdParam,
  readJsonBody,
  withAuthorisedWorkspaceStore,
} from '../../../../server/agents/http';
import { route } from '../../../../server/http/route';

// The repository-wide route invariant (`tests/route-inventory.test.ts`, "runs every route on the
// Node runtime and never prerenders one"). Added by W1-INT-02, for the reason given at the same
// place in `../route.ts`.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Next 15+ resolves a dynamic segment asynchronously, so `params` is a promise. */
type AgentRouteContext = { params: Promise<{ id: string }> };

/** `GET /api/agents/:id` — 404 for an id this workspace does not have, never 403 (§25). */
async function serveGet(request: Request, context: AgentRouteContext): Promise<ApiResult> {
  const id = await readAgentIdParam(context);
  return withAuthorisedWorkspaceStore(request, agentOwnership(id, 'read'), (store) =>
    getAgent(store, id),
  );
}

export const GET = route({ component: 'agents', operation: 'get' }, serveGet);

/**
 * `PATCH /api/agents/:id` — apply a partial update to one agent in the caller's workspace.
 *
 * The body is read *inside* `withWorkspaceStore` so that the workspace gate runs before anything
 * the caller sent is parsed. See the note on `POST /api/agents` in `../route.ts`: a caller who
 * fails the gate must not learn this route's body format, and once W1-CP-06 wires a session the
 * other order would answer `400` where it owes `401`.
 */
async function servePatch(request: Request, context: AgentRouteContext): Promise<ApiResult> {
  const id = await readAgentIdParam(context);
  return withAuthorisedWorkspaceStore(
    request,
    agentOwnership(id, 'update'),
    async (store, runtime, workspaceId, principal) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.result;
      // Issue #535: the patch merged over the agent as stored, with its stored policy and its
      // current connectors, is judged against the deployment's ceiling before it is written.
      // ponytail: check-then-write race until V-2, same as SD11
      const ceiling =
        runtime.ceiling.kind === 'enforced'
          ? runtime.ceiling.ceilingFor(request, workspaceId)
          : null;
      const judge = async (patch: UpdateAgentPatch): Promise<ApiResult | null> => {
        const current = isUuid(id) ? await store.get(id) : null;
        // An edit that keeps the stored name renames nothing, so it is not refused (#1851).
        const reserved =
          patch.name === undefined || patch.name === current?.name
            ? null
            : builderNameRefusal(ceiling, principal.role, patch.name);
        if (reserved !== null) return reserved;
        if (ceiling === null || current === null || !isUuid(id)) return null;
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

      const requested = UpdateAgentPatchSchema.safeParse({
        runtimeProfileId: record['runtimeProfileId'],
      });
      const requestedProfileId = requested.data?.runtimeProfileId;
      if (requestedProfileId === undefined) return updateAgent(store, id, body.value, judge, write);
      const before = await store.get(id);
      if (before === null || before.runtimeProfileId === requestedProfileId) {
        return updateAgent(store, id, body.value, judge, write);
      }
      if (runtime.runtimeSwitchAudit === null) {
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
          toRuntimeProfileId: requestedProfileId,
        });
      }
      return updated;
    },
  );
}

export const PATCH = route({ component: 'agents', operation: 'update' }, servePatch);

/** `DELETE /api/agents/:id` — 204 on success, 404 if the workspace has no such agent. */
async function serveDelete(request: Request, context: AgentRouteContext): Promise<ApiResult> {
  const id = await readAgentIdParam(context);
  return withAuthorisedWorkspaceStore(request, agentOwnership(id, 'delete'), (store) =>
    deleteAgent(store, id),
  );
}

export const DELETE = route({ component: 'agents', operation: 'delete' }, serveDelete);
