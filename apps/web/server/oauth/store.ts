/**
 * The PostgreSQL-backed {@link OAuthRuntime} (ADR-0134 part 3), and the oauth domain's persistence
 * port — the one module of `apps/web/server/oauth` that names `@agent-workspace/core/db` (F-08,
 * W3-5). The endpoints depend on the record and token-row types declared here; the composition
 * root hands the database root in. Copies the shape of `../sessions/store.ts`.
 */
import type {
  AgentGrantRepository,
  AgentRepository,
  DatabaseRoot,
  EndpointClientRepository,
  OAuthClientRecord,
  OAuthTokenRepository,
  WorkspaceScope,
} from '@agent-workspace/core/db';

import { ownershipOf } from '../agents/run-ownership';
import { decide } from '../rbac/decide';
import { a2aResourcePath, BUILDER_RESOURCE_PATH, mcpResourcePath } from './resource';
import type { OAuthRuntime } from './runtime';

/** An endpoint client row as the token endpoint authenticates it. */
export type { OAuthClientRecord };

/** The token-row operations the authorize, token and revoke endpoints perform in one workspace. */
export type OAuthTokenRows = Pick<
  OAuthTokenRepository,
  'issue' | 'consume' | 'revokeFamily' | 'revoke'
>;

type StoreRoot = Pick<
  DatabaseRoot,
  'scopes' | 'oauthTokens' | 'auditEventRepository' | 'findOAuthClient'
> & {
  readonly agents: { forScope(scope: WorkspaceScope): Pick<AgentRepository, 'get'> };
  readonly agentGrants: { forScope(scope: WorkspaceScope): Pick<AgentGrantRepository, 'hasGrant'> };
  readonly endpointClients: {
    forScope(scope: WorkspaceScope): Pick<EndpointClientRepository, 'get'>;
  };
  readonly directory: Pick<
    DatabaseRoot['directory'],
    'principalById' | 'findIdentity' | 'membershipsForUser'
  >;
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
      switch (record.kind) {
        case 'mcp-project':
          resourcePath = mcpResourcePath(record.name);
          break;
        case 'builder':
          resourcePath = BUILDER_RESOURCE_PATH;
          break;
        case 'app-backend':
          // Its tokens come from the exchange alone, whose resource is never an endpoint's URL.
          resourcePath = null;
          break;
        case 'a2a-agent': {
          // The A2A route is addressed by the agent's name, which is not the client's.
          const agentId = bound.agentIds[0];
          const agent =
            agentId === undefined ? null : await root.agents.forScope(scope).get(agentId);
          resourcePath = agent === null ? null : a2aResourcePath(agent.name);
          break;
        }
        default: {
          const unreachable: never = record.kind;
          throw new Error(`unhandled endpoint client kind ${String(unreachable)}`);
        }
      }
      // Only the builder consent page renders the label, so other kinds skip the lookup.
      const creator =
        record.kind === 'builder'
          ? await root.directory.principalById(record.workspaceId, bound.createdByPrincipalId)
          : null;
      return {
        ...record,
        agentIds: bound.agentIds,
        resourcePath,
        ...(creator === null ? {} : { creatorLabel: creator.label }),
      };
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
    async findMember(workspaceId, issuer, subject) {
      const identity = await root.directory.findIdentity(issuer, subject);
      if (identity === null) return null;
      const memberships = await root.directory.membershipsForUser(identity.userId);
      const membership = memberships.find((row) => row.workspaceId === workspaceId);
      if (membership === undefined) return null;
      const principal = await root.directory.principalById(workspaceId, membership.principalId);
      if (principal === null || principal.kind !== 'membership') return null;
      return {
        userId: identity.userId,
        principalId: membership.principalId,
        label: principal.label,
      };
    },
    async issueExchanged(client, member, token) {
      const tokens = root.oauthTokens.forScope(await scopeOf(client.workspaceId));
      await tokens.issueExchanged(
        {
          id: token.id,
          clientId: client.id,
          kind: 'access',
          tokenHash: token.tokenHash,
          subjectPrincipalId: member.principalId,
          resource: token.resource,
          familyId: token.familyId,
          expiresAt: token.expiresAt,
        },
        {
          actorPrincipalId: member.principalId,
          actorUserId: member.userId,
          actorLabel: member.label,
          clientId: client.id,
          clientName: client.name,
        },
      );
    },
  };
}
