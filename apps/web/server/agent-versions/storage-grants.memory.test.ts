/**
 * Storing storage grants in the in-memory version store: the shared conformance scenarios
 * (`storage-grants.conformance.ts`), which `storage-grants.postgres.test.ts` runs against core's
 * repository.
 */
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { createInMemoryAgentVersionStoreProvider } from './memory-store';
import { describeStorageGrantStore } from './storage-grants.conformance';

const WORKSPACE = '66666666-6666-4666-8666-666666666666';

describeStorageGrantStore('the in-memory version store', async () => {
  const provider = createInMemoryAgentVersionStoreProvider({
    agents: createInMemoryAgentStoreProvider(),
  });
  const store = await provider.forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  return {
    store,
    principalId: crypto.randomUUID(),
    connections: { first: crypto.randomUUID(), second: crypto.randomUUID() },
    grantsOf: (agentId) => Promise.resolve(provider.assignmentsOf(agentId)?.storageGrants ?? []),
    grantAuditsOf: (agentId) =>
      Promise.resolve(
        provider
          .audits()
          .filter((row) => row.action === 'storage-grant-changed' && row.subjectId === agentId)
          .map((row) => row.subjectLabel),
      ),
  };
});
