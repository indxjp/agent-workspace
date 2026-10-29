import { requireWorkspaceScope } from './scope.js';
import type {
  StorageConnectionRecord,
  StorageConnectionRepositoryProvider,
} from './storage-connections.js';

/** The in-memory twin of the PostgreSQL provider; both run `describeStorageConnectionsConformance`. */
export function createInMemoryStorageConnectionRepositoryProvider(): StorageConnectionRepositoryProvider {
  const byWorkspace = new Map<string, Map<string, StorageConnectionRecord>>();
  return {
    forScope(scope) {
      const { workspaceId } = requireWorkspaceScope(scope, 'StorageConnectionRepositoryProvider');
      const rows = byWorkspace.get(workspaceId) ?? new Map<string, StorageConnectionRecord>();
      byWorkspace.set(workspaceId, rows);
      return {
        list: () => Promise.resolve([...rows.values()]),
        listByNames: (names) =>
          Promise.resolve([...rows.values()].filter((row) => names.includes(row.name))),
        get: (id) => Promise.resolve(rows.get(id) ?? null),
        create(input) {
          if ([...rows.values()].some((row) => row.name === input.name)) {
            return Promise.resolve({ kind: 'name-conflict', name: input.name });
          }
          const now = new Date();
          const connection: StorageConnectionRecord = {
            ...input,
            workspaceId,
            createdAt: now,
            updatedAt: now,
          };
          rows.set(connection.id, connection);
          return Promise.resolve({ kind: 'created', connection });
        },
        update(id, patch) {
          const current = rows.get(id);
          if (current === undefined) return Promise.resolve({ kind: 'not-found' });
          const name = patch.name ?? current.name;
          if ([...rows.values()].some((row) => row.id !== id && row.name === name)) {
            return Promise.resolve({ kind: 'name-conflict', name });
          }
          const connection: StorageConnectionRecord = {
            ...current,
            name,
            url: patch.url ?? current.url,
            allowedPrefixes: patch.allowedPrefixes ?? current.allowedPrefixes,
            writeAllowed: patch.writeAllowed ?? current.writeAllowed,
            updatedAt: new Date(),
          };
          rows.set(id, connection);
          return Promise.resolve({ kind: 'updated', connection });
        },
        delete(id) {
          const current = rows.get(id) ?? null;
          rows.delete(id);
          return Promise.resolve(current);
        },
      };
    },
  };
}
