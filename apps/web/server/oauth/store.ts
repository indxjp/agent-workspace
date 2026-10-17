/**
 * The PostgreSQL-backed {@link OAuthRuntime} (ADR-0134 part 3).
 */
import type {
  AgentGrantRepository,
  AgentRepository,
  DatabaseRoot,
  EndpointClientRepository,
  WorkspaceScope,
} from '@agent-workspace/core/db';

import { ownershipOf } from '../agents/run-ownership';
import { decide } from '../rbac/decide';
import { a2aResourcePath, mcpResourcePath } from './resource';
import type { OAuthRuntime } from './runtime';

type StoreRoot = Pick<
  DatabaseRoot,
  'scopes' | 'oauthTokens' | 'auditEventRepository' | 'findOAuthClient'
> & {
  readonly agents: { forScope(scope: WorkspaceScope): Pick<AgentRepository, 'get'> };
  readonly agentGrants: { forScope(scope: WorkspaceScope): Pick<AgentGrantRepository, 'hasGrant'> };
  readonly endpointClients: {
    forScope(scope: WorkspaceScope): Pick<EndpointClientRepository, 'get'>;
  };
  readonly directory: Pick<DatabaseRoot['directory'], 'principalById'>;
};

export function createRepositoryOAuthRuntime(root: StoreRoot): OAuthRuntime {
  const scopeOf = async (workspaceId: string) => {
    const scope = await root.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('oauth workspace no longer exists');
    return scope;
  };

  return {
    async findClient(clientId) {
      const record = await root.findOAuthClient(clientId);
      if (record === null) return null;
      const scope = await scopeOf(record.workspaceId);
      const bound = await root.endpointClients.forScope(scope).get(record.id);
      if (bound === null) return null;
      let resourcePath: string | null;
      if (record.kind === 'mcp-project') {
        resourcePath = mcpResourcePath(record.name);
      } else {
        // The A2A route is addressed by the agent's name, which is not the client's.
        const agentId = bound.agentIds[0];
        const agent = agentId === undefined ? null : await root.agents.forScope(scope).get(agentId);
        resourcePath = agent === null ? null : a2aResourcePath(agent.name);
      }
      return { ...record, agentIds: bound.agentIds, resourcePath };
    },
    async canRunAll(principal, agentIds) {
      // The same ownership rule as `POST /api/agents/:id/runs`, read from the database root so the
      // consent check does not depend on the in-process agents runtime being configured.
      const scope = await scopeOf(principal.workspaceId);
      const agents = root.agents.forScope(scope);
      const grants = root.agentGrants.forScope(scope);
      for (const agentId of agentIds) {
        const ownership = await ownershipOf(principal, await agents.get(agentId), grants);
        const decision = decide({
          role: principal.role,
          method: 'POST',
          path: `/api/agents/${agentId}/runs`,
          ownership,
          scope: null,
        });
        if (ownership === 'unknown' || decision.effect !== 'allow') return false;
      }
      return true;
    },
    async agentNames(workspaceId, agentIds) {
      // Read from the database, not the in-process agents runtime: a consent page that cannot
      // name the agents must not render as "reaches nothing", so a vanished agent is `null`.
      const agents = root.agents.forScope(await scopeOf(workspaceId));
      const names: string[] = [];
      for (const id of agentIds) {
        const agent = await agents.get(id);
        if (agent === null) return null;
        names.push(agent.name);
      }
      return names;
    },
    async tokens(workspaceId) {
      return root.oauthTokens.forScope(await scopeOf(workspaceId));
    },
    async audit(workspaceId, actorPrincipalId, event) {
      const actor = await root.directory.principalById(workspaceId, actorPrincipalId);
      await root.auditEventRepository.forScope(await scopeOf(workspaceId)).write({
        actorPrincipalId,
        actorUserId: actor?.userId ?? null,
        actorLabel: actor?.label ?? 'unknown',
        action: event.action,
        subjectId: event.clientId,
        subjectLabel: `${event.clientName} (${event.detail})`,
      });
    },
  };
}
