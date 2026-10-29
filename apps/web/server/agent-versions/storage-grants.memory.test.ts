/**
 * Storing storage grants in the in-memory version store: the shared conformance scenarios
 * (`storage-grants.conformance.ts`), which `storage-grants.postgres.test.ts` runs against core's
 * repository. The grants are read back through the agent resource store, as the resources GET
 * reads them, so the memory store must hand them to it as PostgreSQL's shared tables do.
 */
import type { AgentResourceAssignments } from '@agent-workspace/core/db';

import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import type { AgentResourceStoreProvider } from '../agents/resource-store';
import { createInMemoryAgentVersionStoreProvider } from './memory-store';
import { describeStorageGrantStore } from './storage-grants.conformance';

const WORKSPACE = '66666666-6666-4666-8666-666666666666';

/** A resource store over one map, as the agents routes' memory runtime keeps it. */
function memoryResources(): AgentResourceStoreProvider {
  const stored = new Map<string, AgentResourceAssignments>();
  return {
    forWorkspace: (workspaceId) => ({
      get: (agentId) => Promise.resolve(stored.get(`${workspaceId}:${agentId}`) ?? null),
      replace: (agentId, next) => {
        const assignments = { ...next, storageGrants: next.storageGrants ?? [] };
        stored.set(`${workspaceId}:${agentId}`, assignments);
        return Promise.resolve({ kind: 'updated' as const, assignments });
      },
    }),
  };
}

describeStorageGrantStore('the in-memory version store', async () => {
  const resources = memoryResources();
  const provider = createInMemoryAgentVersionStoreProvider({
    agents: createInMemoryAgentStoreProvider(),
    resources,
  });
  const store = await provider.forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  return {
    store,
    principalId: crypto.randomUUID(),
    connections: { first: crypto.randomUUID(), second: crypto.randomUUID() },
    grantsOf: async (agentId) =>
      (await resources.forWorkspace(WORKSPACE).get(agentId))?.storageGrants ?? [],
    grantAuditsOf: (agentId) =>
      Promise.resolve(
        provider
          .audits()
          .filter((row) => row.action === 'storage-grant-changed' && row.subjectId === agentId)
          .map((row) => row.subjectLabel),
      ),
  };
});
