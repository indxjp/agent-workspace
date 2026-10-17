import type {
  CreateModelConnectionInput as CoreCreateInput,
  CreateModelConnectionOutcome,
  DeleteModelConnectionOutcome,
  ModelConnectionRecord,
  ModelConnectionRepository,
  ModelConnectionRepositoryProvider,
  UpdateModelConnectionOutcome,
  UpdateModelConnectionPatch,
  WorkspaceScope,
} from '@agent-workspace/core/db';
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { createInMemorySecretsService } from '@agent-workspace/core/secrets';

import { createRepositoryModelsStoreProvider, type ModelsStoreProvider } from './store';

function inMemoryRepositories(): ModelConnectionRepositoryProvider {
  const byWorkspace = new Map<string, Map<string, ModelConnectionRecord>>();
  return {
    forScope(scope: WorkspaceScope): ModelConnectionRepository {
      let rows = byWorkspace.get(scope.workspaceId);
      if (rows === undefined) {
        rows = new Map();
        byWorkspace.set(scope.workspaceId, rows);
      }
      const current = rows;
      const conflicting = (name: string, except?: string) =>
        [...current.values()].some((row) => row.id !== except && row.name === name);
      return {
        list: () => Promise.resolve([...current.values()]),
        get: (id) => Promise.resolve(current.get(id) ?? null),
        create(input: CoreCreateInput): Promise<CreateModelConnectionOutcome> {
          if (conflicting(input.name))
            return Promise.resolve({ kind: 'name-conflict', name: input.name });
          const now = new Date();
          const connection: ModelConnectionRecord = {
            ...input,
            workspaceId: scope.workspaceId,
            createdAt: now,
            updatedAt: now,
          };
          current.set(connection.id, connection);
          return Promise.resolve({ kind: 'created', connection });
        },
        update(
          id: string,
          patch: UpdateModelConnectionPatch,
        ): Promise<UpdateModelConnectionOutcome> {
          const existing = current.get(id);
          if (existing === undefined) return Promise.resolve({ kind: 'not-found' });
          if (patch.name !== undefined && conflicting(patch.name, id)) {
            return Promise.resolve({ kind: 'name-conflict', name: patch.name });
          }
          const connection = { ...existing, ...patch, updatedAt: new Date() };
          current.set(id, connection);
          return Promise.resolve({ kind: 'updated', connection });
        },
        delete(id: string): Promise<DeleteModelConnectionOutcome> {
          const connection = current.get(id);
          if (connection === undefined) return Promise.resolve({ kind: 'not-found' });
          current.delete(id);
          // This in-memory double models no `agents` table, so there is never anyone to report —
          // the real PostgreSQL repository is what `model-connections.test.ts` holds to the real
          // referencing-agents behaviour.
          return Promise.resolve({ kind: 'deleted', connection, referencedBy: [] });
        },
      };
    },
  };
}

export function createInMemoryModelsStoreProvider(
  workspaceIds: readonly string[],
): ModelsStoreProvider {
  const scopes = createInMemoryWorkspaceScopeResolver(workspaceIds.map((id) => ({ id, slug: id })));
  return createRepositoryModelsStoreProvider({
    repositories: inMemoryRepositories(),
    scopes,
    secrets: createInMemorySecretsService(),
  });
}
