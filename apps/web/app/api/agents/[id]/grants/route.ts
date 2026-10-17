import { AgentGrantsSchema } from '../../../../../contracts/agents';

import { agentNotFound, problem } from '../../../../../server/agents/handlers';
import { isUuid } from '../../../../../server/agents/contract';
import {
  readAgentIdParam,
  readJsonBody,
  toResponse,
  withWorkspaceStore,
} from '../../../../../server/agents/http';
import { currentAgentsRuntime } from '../../../../../server/agents/runtime';
import { requireResourceAccess } from '../../../../../server/resources/authorise';
import type { OwnershipResolver } from '../../../../../server/rbac/http';

function ownershipOf(id: unknown): OwnershipResolver {
  return async (principal) => {
    const runtime = currentAgentsRuntime();
    if (runtime === null || !isUuid(id)) return { kind: 'refuse', result: agentNotFound() };
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
      if (typeof id !== 'string') return agentNotFound();
      if (installed.agentGrants === undefined) {
        return problem(503, 'agent_grants_not_configured', 'Agent grants are not configured.');
      }
      const principalIds = await installed.agentGrants
        .forWorkspace(workspaceId)
        .listPrincipalIds(id);
      return principalIds === null ? agentNotFound() : { status: 200, body: { principalIds } };
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
    async (_agents, installed, workspaceId) => {
      if (typeof id !== 'string') return agentNotFound();
      if (installed.agentGrants === undefined) {
        return problem(503, 'agent_grants_not_configured', 'Agent grants are not configured.');
      }
      const body = await readJsonBody(request);
      if (!body.ok) return body.result;
      const parsed = AgentGrantsSchema.safeParse(body.value);
      if (!parsed.success) {
        return problem(
          400,
          'invalid_agent_grants',
          'principalIds must be a list of unique principal UUIDs.',
        );
      }
      const outcome = await installed.agentGrants
        .forWorkspace(workspaceId)
        .replacePrincipalIds(id, parsed.data.principalIds);
      if (outcome.kind === 'agent-not-found') return agentNotFound();
      if (outcome.kind === 'principal-not-found') {
        return problem(
          404,
          'principal_not_found',
          'This workspace has no current membership principal with that id.',
        );
      }
      return { status: 200, body: { principalIds: outcome.principalIds } };
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}
