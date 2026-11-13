import type { AgentRecord } from '../../../agents/contract';
import { setAgentPointer } from '../../../agent-versions/pointers';
import { type AgentVersionStoreProvider } from '../../../agent-versions/store';
import { type AgentStoreProvider } from '../../../agents/store';
import { callContextOf } from '../../testing/context';
import { createAgentStore } from './production';
import { type StoreFixture } from './store.contract';

/**
 * The production adapter over `agents` and `versions`, with the person `principalId` in
 * `workspaceId`, and `otherWorkspaceId` a second workspace the stores resolve.
 */
interface ProductionFixtureOptions {
  readonly agents: AgentStoreProvider;
  readonly versions: AgentVersionStoreProvider;
  readonly person: {
    workspaceId: string;
    otherWorkspaceId: string;
    principalId: string;
    userId: string | null;
  };
  readonly markBuiltin: StoreFixture['markBuiltin'];
  readonly auditEvents: StoreFixture['auditEvents'];
}

export function productionFixture({
  agents,
  versions,
  person,
  markBuiltin,
  auditEvents,
}: ProductionFixtureOptions): StoreFixture {
  const { workspaceId, otherWorkspaceId, principalId, userId } = person;
  const state = async (agentId: string) => {
    const store = await versions.forWorkspace(workspaceId);
    const listing = await store?.list(agentId);
    if (listing === null || listing === undefined) throw new Error('the agent exists');
    const pointer = (environment: string) =>
      listing.pointers.find((candidate) => candidate.environment === environment)?.number ?? null;
    return {
      versions: listing.versions.map(({ number, via, createdByPrincipalId }) => ({
        number,
        via,
        createdByPrincipalId,
      })),
      local: pointer('local'),
      production: pointer('production'),
    };
  };
  return {
    port: createAgentStore({
      agents,
      versions,
      pipeline: () => ({}),
      actorLabel: (_workspaceId, id) => Promise.resolve(`${id}@example.test`),
    }),
    ctx: callContextOf(workspaceId, 'builder', principalId, userId),
    viewer: callContextOf(workspaceId, 'viewer'),
    noCaller: callContextOf(workspaceId, null),
    otherWorkspace: callContextOf(otherWorkspaceId, 'builder', principalId),
    personId: principalId,
    markBuiltin,
    auditEvents,
    inspect: state,
    async seedProduction(agentId, version) {
      const store = await versions.forWorkspace(workspaceId);
      const agent = await agents.forWorkspace(workspaceId).get(agentId);
      if (store === null || agent === null) throw new Error('the agent exists');
      const moved = await setAgentPointer(
        { environment: 'production', version },
        agent,
        { principalId, userId, actor: `${principalId}@example.test` },
        { store },
      );
      if (moved.status !== 200) throw new Error(`promotion answered ${String(moved.status)}`);
    },
  };
}

export function withAgentReadOverride(
  agents: AgentStoreProvider,
  override: (agent: AgentRecord, agentId: string) => AgentRecord,
): AgentStoreProvider {
  return {
    forWorkspace: (workspaceId) => {
      const bound = agents.forWorkspace(workspaceId);
      return {
        ...bound,
        get: async (agentId) => {
          const agent = await bound.get(agentId);
          return agent === null ? null : override(agent, agentId);
        },
      };
    },
  };
}
