import { AgentVersionBodySchema } from '@indx-workspace/contracts/agent-versions';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';

import { isUuid } from '../../../agents/contract';
import { awControlAllowed } from '../../agent/aw-control-allowed';
import { ownershipOf } from '../../../agents/run-ownership';
import { decide, type Ownership } from '../../../rbac/decide';
import { isBuilderAgent } from '../../agent/is-builder-agent';
import type { AgentRecord } from '../../../agents/contract';
import type { Facts } from '../../core/facts';
import type { AuthorizationPort, BuilderToolKind } from '../../ports';

type Access = Facts['access'];

/** The slice of the agent and grant stores this adapter reads; the real stores satisfy it. */
export interface AuthorizationDeps {
  readonly agents: {
    forWorkspace(workspaceId: string): {
      get(
        id: string,
      ): Promise<Pick<
        AgentRecord,
        'id' | 'ownerPrincipalId' | 'name' | 'builtin' | 'createdByAgent'
      > | null>;
    };
  };
  /** The version store, to read the body of the version a non-Builder agent's run is pinned to. */
  readonly versions: {
    forWorkspace(workspaceId: string): Promise<{
      find(agentId: string, number: number): Promise<{ readonly body: unknown } | null>;
    } | null>;
  };
  /** The deployment's `AW_DEPLOYMENT_POLICY` and nothing else: a project file's policy never decides who builds. */
  readonly ceiling: ProjectPolicy | null;
  readonly grants?:
    | {
        forWorkspace(workspaceId: string): {
          hasGrant(agentId: string, userId: string): Promise<boolean>;
        };
      }
    | undefined;
}

/** The console route a tool of this kind stands for, so the caller meets the rule the console applies. */
function routeOf(
  kind: BuilderToolKind,
  hasAgent: boolean,
): { readonly method: string; readonly path: string } | null {
  switch (kind) {
    case 'read':
      return { method: 'GET', path: hasAgent ? '/api/agents/:id' : '/api/agents' };
    case 'write':
      return { method: 'POST', path: hasAgent ? '/api/agents/:id/versions' : '/api/agents' };
    case 'spend':
      return hasAgent ? { method: 'POST', path: '/api/agents/:id/runs' } : null;
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

/** The caller's own RBAC decision, never a system principal's; every doubt fails closed. */
export function createAuthorization(deps: AuthorizationDeps): AuthorizationPort {
  return {
    async creator(ctx) {
      if (ctx.door.kind === 'external') return { kind: 'external' };
      const { agentId, agentVersion } = ctx.door;
      const agent = await deps.agents.forWorkspace(ctx.workspaceId).get(agentId);
      if (agent === null) return null;
      if (isBuilderAgent(agent)) return { kind: 'builder' };
      const versions = await deps.versions.forWorkspace(ctx.workspaceId);
      const body = AgentVersionBodySchema.safeParse(
        (await versions?.find(agentId, agentVersion))?.body,
      );
      if (!body.success) return null;
      const madeByAgent = agent.createdByAgent != null;
      return {
        kind: 'agent',
        body: body.data,
        allowedToBuild: awControlAllowed(agent, deps.ceiling),
        madeByAgent,
      };
    },

    async target(ctx, agentId, version) {
      if (ctx.door.kind !== 'run') return null;
      const agent = await deps.agents.forWorkspace(ctx.workspaceId).get(agentId);
      if (agent === null) return null;
      const versions = await deps.versions.forWorkspace(ctx.workspaceId);
      const body = AgentVersionBodySchema.safeParse((await versions?.find(agentId, version))?.body);
      if (!body.success) return null;
      return { body: body.data };
    },

    async access(ctx, kind, agentId): Promise<Access> {
      if (ctx.caller.kind === 'none') return 'not_permitted';
      const { principal } = ctx.caller;
      if (principal.workspaceId !== ctx.workspaceId) return 'not_permitted';
      const route = routeOf(kind, agentId !== undefined);
      if (route === null) return 'not_permitted';

      let ownership: Ownership = 'not-applicable';
      if (agentId !== undefined) {
        // A missing agent looks exactly like someone else's, so a probe learns nothing.
        if (!isUuid(agentId)) return 'not_owner';
        const agent = await deps.agents.forWorkspace(ctx.workspaceId).get(agentId);
        if (agent === null) return 'not_owner';
        ownership = await ownershipOf(principal, agent, deps.grants?.forWorkspace(ctx.workspaceId));
      }

      const decision = decide({ role: principal.role, ...route, ownership, scope: null });
      switch (decision.effect) {
        case 'allow':
          return 'allowed';
        case 'deny':
          return decision.facts?.grant === 'none' || decision.facts === null
            ? 'not_permitted'
            : 'not_owner';
        case 'refuse':
          return 'not_permitted';
        default: {
          const unhandled: never = decision;
          return unhandled;
        }
      }
    },
  };
}
