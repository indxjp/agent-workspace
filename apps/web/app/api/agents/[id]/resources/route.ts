import type { AgentResourceAssignments } from '../../../../../contracts/agents';

import { agentNotFound, problem } from '../../../../../server/agents/handlers';
import { isUuid } from '../../../../../server/agents/contract';
import {
  readAgentIdParam,
  readJsonBody,
  toResponse,
  withWorkspaceStore,
} from '../../../../../server/agents/http';
import { currentAgentsRuntime } from '../../../../../server/agents/runtime';
import { saveConsoleEdit } from '../../../../../server/agent-versions/http';
import { judgeAgent } from '../../../../../server/policy-ceiling/ceiling';
import { requireResourceAccess } from '../../../../../server/resources/authorise';
import type { OwnershipResolver } from '../../../../../server/rbac/http';

/**
 * Issue #117: load the agent within the caller's workspace, answer an indistinguishable 404 when
 * it is absent, and only then let `decide()` compare `created_by` against the caller. Built as a
 * bare {@link OwnershipResolver} rather than through `resources/item-ownership.ts`'s
 * `resolverForRow`: unlike the sibling `[id]/route.ts`, this route calls `requireResourceAccess`
 * before any workspace-scoped store is resolved, so the id is looked up straight from the
 * installed agents runtime once the resolver is handed the verified `principal`'s workspace,
 * rather than from a store closed over one.
 */
function ownershipOf(id: unknown): OwnershipResolver {
  return async (principal) => {
    const runtime = currentAgentsRuntime();
    if (runtime === null || !isUuid(id)) {
      return { kind: 'refuse', result: agentNotFound() };
    }
    const row = await runtime.agents.forWorkspace(principal.workspaceId).get(id);
    if (row === null) return { kind: 'refuse', result: agentNotFound() };
    return {
      kind: 'ownership',
      ownership: principal.ownerPrincipalId === row.ownerPrincipalId ? 'own' : 'other',
    };
  };
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function parseAssignments(raw: unknown): AgentResourceAssignments | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (
    !Array.isArray(body['files']) ||
    !Array.isArray(body['skillIds']) ||
    !Array.isArray(body['connectorIds'])
  )
    return null;
  const files = body['files'];
  if (
    !files.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>)['fileId'] === 'string' &&
        ((entry as Record<string, unknown>)['access'] === 'read' ||
          (entry as Record<string, unknown>)['access'] === 'read-write'),
    )
  )
    return null;
  if (
    !body['skillIds'].every((id) => typeof id === 'string') ||
    !body['connectorIds'].every((id) => typeof id === 'string')
  )
    return null;
  return {
    files: files as unknown as AgentResourceAssignments['files'],
    skillIds: body['skillIds'],
    connectorIds: body['connectorIds'],
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readAgentIdParam(context);
  const access = await requireResourceAccess(request, ownershipOf(id));
  if (!access.ok) return access.response;
  const result = await withWorkspaceStore(
    request,
    async (_agents, installed, workspaceId) => {
      if (typeof id !== 'string')
        return problem(400, 'invalid_agent_id', 'The agent id is missing.');
      if (installed.agentResources === undefined)
        return problem(
          503,
          'agent_resources_not_configured',
          'Agent resource assignments are not configured.',
        );
      const assignments = await installed.agentResources.forWorkspace(workspaceId).get(id);
      return assignments === null
        ? problem(404, 'agent_not_found', 'This workspace has no agent with that id.')
        : { status: 200, body: { assignments } };
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readAgentIdParam(context);
  const access = await requireResourceAccess(request, ownershipOf(id));
  if (!access.ok) return access.response;
  const result = await withWorkspaceStore(
    request,
    async (agents, installed, workspaceId) => {
      if (typeof id !== 'string')
        return problem(400, 'invalid_agent_id', 'The agent id is missing.');
      if (installed.agentResources === undefined)
        return problem(
          503,
          'agent_resources_not_configured',
          'Agent resource assignments are not configured.',
        );
      const parsed = await readJsonBody(request);
      if (!parsed.ok) return parsed.result;
      const assignments = parseAssignments(parsed.value);
      if (assignments === null)
        return problem(
          400,
          'invalid_assignments',
          'files, skillIds, and connectorIds are required assignment arrays.',
        );
      // Issue #133: the agent's own `writeFiles` permission is a ceiling on a `'read-write'` file
      // grant. Applied inside `AgentResourceRepository.replace` (`packages/core/src/db/
      // repositories/agent-resources.ts`), not here — that repository is the one call site both
      // this route and `POST /api/agents`'s own assignment write share, so the ceiling holds for
      // both without either route needing to fetch the agent's permissions itself.
      //
      // Issue #535: the agent with these connectors is judged against the deployment's ceiling.
      // ponytail: check-then-write race until V-2, same as SD11
      const ceiling = installed.ceilingFor?.(request, workspaceId) ?? null;
      const agent = await agents.get(id);
      if (agent === null) return agentNotFound();
      if (ceiling !== null) {
        const refused = await judgeAgent(agent, assignments.connectorIds, ceiling, {
          id,
          label: agent.name,
        });
        if (refused !== null) return refused;
      }
      // Issue #616: a console edit is saved as a version (`via: 'ui'`) and `local` points at it.
      const unsaved = await saveConsoleEdit(
        agent,
        { kind: 'resources', assignments },
        access.principal,
        ceiling,
      );
      if (unsaved !== null) return unsaved;
      const saved = await installed.agentResources.forWorkspace(workspaceId).get(id);
      return saved === null ? agentNotFound() : { status: 200, body: { assignments: saved } };
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}
