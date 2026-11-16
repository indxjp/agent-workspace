import {
  type CatalogPort,
  type CatalogSkill,
  type ResourceCatalogRepositoryProvider,
} from './resource-catalogs.js';
import { requireWorkspaceScope } from './scope.js';
import {
  type Row,
  type SkillState,
  type StoredRevision,
  type InMemoryWorkspaceCatalog,
} from './memory-catalog-model.js';
import { createMemoryFileCatalog } from './memory-catalog-files.js';
import { createMemorySkillCatalog } from './memory-catalog-skills.js';

export type { InMemoryWorkspaceCatalog } from './memory-catalog-model.js';
export function createInMemoryCatalog(): ResourceCatalogRepositoryProvider & {
  forWorkspace(id: string): InMemoryWorkspaceCatalog;
  /** Test hook, not part of the port: the next call of `op` (any workspace) rejects with `error`. */
  failNext(op: keyof CatalogPort, error: Error): void;
} {
  const workspaces = new Map<string, Map<string, Row>>();

  const skillStates = new Map<string, SkillState>();

  const failures = new Map<keyof CatalogPort, Error>();

  // When each row was reserved, for `stalePending`; the database keeps it in `updated_at`. Shared by
  // every handle, as the rows are: row ids are UUIDs, so one map serves every workspace.
  const reservedAt = new Map<string, Date>();
  const forWorkspace = (workspaceId: string): InMemoryWorkspaceCatalog => {
    const rows = workspaces.get(workspaceId) ?? new Map<string, Row>();

    workspaces.set(workspaceId, rows);

    const state: SkillState = skillStates.get(workspaceId) ?? {
      skills: new Map<string, CatalogSkill>(),
      revisions: new Map<string, StoredRevision[]>(),
      assignments: new Map<string, Set<string>>(),
    };

    skillStates.set(workspaceId, state);
    return {
      ...createMemoryFileCatalog({ rows, reservedAt, failures }),
      ...createMemorySkillCatalog(state),
    };
  };

  return {
    forScope: (scope) =>
      forWorkspace(requireWorkspaceScope(scope, 'InMemoryCatalogProvider').workspaceId),
    forWorkspace,
    failNext: (op, error) => {
      failures.set(op, error);
    },
  };
}
