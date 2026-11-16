/**
 * Memory-only version state. Refusals precede writes, and only local pointer moves materialise
 * agent rows. Resolution and permission narrowing use the same rules as the repository adapter.
 */
import type {
  InMemoryAgentVersionStoreOptions,
  InMemoryAgentVersionStoreProvider,
} from './memory-store/model';
import { createMemoryVersionQueries } from './memory-store/queries';
import { createMemoryVersionState } from './memory-store/state';
import { createMemoryVersionWorkspace } from './memory-store/workspace';
import { createMemoryVersionWrites } from './memory-store/writes';
import type { WorkspaceAgentVersionStore } from './store';
export type {
  InMemoryAgentVersionStoreOptions,
  InMemoryAgentVersionStoreProvider,
  MaterialisedAssignments,
  RecordedPointerAudit,
  SeededPointer,
  SeededReference,
  SeededReferences,
} from './memory-store/model';

/** Memory-only version state, shared by workspace-bound stores. */
export function createInMemoryAgentVersionStoreProvider(
  options: InMemoryAgentVersionStoreOptions,
): InMemoryAgentVersionStoreProvider {
  const state = createMemoryVersionState(options);
  const { versions, pointers, audits, assignments, evaluations, movePointer } = state;
  function createWorkspaceStore(workspaceId: string): WorkspaceAgentVersionStore {
    const workspace = createMemoryVersionWorkspace(state, workspaceId);
    return { ...createMemoryVersionQueries(workspace), ...createMemoryVersionWrites(workspace) };
  }
  return {
    forWorkspace: (workspaceId) => Promise.resolve(createWorkspaceStore(workspaceId)),
    versionCount: () => versions.length,
    pointerCount: () => pointers.length,
    audits: () => [...audits],
    point: (pointer) => {
      movePointer(pointer, 'set', null);
    },
    assignmentsOf: (agentId) => assignments.get(agentId),
    recordEvaluation: (versionId, evaluation) => {
      evaluations.set(versionId, evaluation);
    },
  };
}
