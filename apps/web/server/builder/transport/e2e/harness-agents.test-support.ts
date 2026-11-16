import { randomUUID } from 'node:crypto';
import { createInMemoryAgentVersionStoreProvider } from '../../../agent-versions/memory-store';
import type { AgentRecord } from '../../../agents/contract';
import { createInMemoryAgentStoreProvider } from '../../../agents/memory-store';
import { WORKSPACE, BUILDER_AGENT } from './harness-contract.test-support';

export function createHarnessAgents() {
  const memoryAgents = createInMemoryAgentStoreProvider();
  /** The in-memory stores drop an agent's lineage (PostgreSQL keeps it), so the harness keeps it by agent id. */
  const lineage = new Map<string, NonNullable<AgentRecord['createdByAgent']>>();
  const withLineage = (agent: AgentRecord | null): AgentRecord | null => {
    const madeBy = agent === null ? undefined : lineage.get(agent.id);
    return agent === null || madeBy === undefined ? agent : { ...agent, createdByAgent: madeBy };
  };
  /** The in-memory store knows no built-in agent, so the Builder is added to what `get` can see. */
  const agents: typeof memoryAgents = {
    ...memoryAgents,
    forWorkspace: (workspaceId) => {
      const store = memoryAgents.forWorkspace(workspaceId);
      return {
        ...store,
        get: async (id) =>
          id === BUILDER_AGENT
            ? {
                id,
                workspaceId,
                name: 'builder',
                builtin: 'builder' as const,
                instructions: '',
                modelConnectionId: null,
                model: null,
                runtimeProfileId: null,
                permissions: {
                  readFiles: false,
                  writeFiles: false,
                  runCommands: false,
                  unrestrictedNetwork: false,
                },
                policy: null,
                createdBy: null,
                ownerPrincipalId: randomUUID(),
                createdAt: new Date(0),
                updatedAt: new Date(0),
              }
            : withLineage(await store.get(id)),
      };
    },
  };
  const memoryVersions = createInMemoryAgentVersionStoreProvider({
    agents,
    references: { [WORKSPACE]: { connector: [{ id: 'connector-crm', name: 'crm' }] } },
  });
  const versions: typeof memoryVersions = {
    ...memoryVersions,
    forWorkspace: async (workspaceId) => {
      const store = await memoryVersions.forWorkspace(workspaceId);
      return store === null
        ? null
        : {
            ...store,
            async createAgentWithFirstVersion(input) {
              const created = await store.createAgentWithFirstVersion(input);
              if (created.kind === 'created' && input.agent.createdByAgent != null) {
                lineage.set(created.agent.id, input.agent.createdByAgent);
              }
              return created;
            },
          };
    },
  };

  return { agents, versions };
}
