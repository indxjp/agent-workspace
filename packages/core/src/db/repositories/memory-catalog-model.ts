import { fileStatuses, type FileStatus } from '../schema/files.js';
import { isSidePath } from '../side-paths.js';
import { storageAreas } from '../../storage/storage-areas.js';
import {
  type CatalogFile,
  type CatalogSkill,
  type CatalogSkillRevision,
  type ResourceCatalogRepository,
} from './resource-catalogs.js';

export type Row = CatalogFile & { readonly status: FileStatus };

// What a new row holds until a writer sets it: a folder has no object id, a file's checksum comes
// with its confirm (the storage design, §04). Only a pending row carries a reservation token.
export const NEW_ROW = {
  objectId: null,
  area: 'files',
  sha256: null,
  targetPath: null,
  reservationToken: null,
} as const;

// Mirrors `files_sha256_shape`.
export const SHA256_SHAPE = /^[0-9a-f]{64}$/;

export const underPrefix = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}/`);

// The path a row stands for: its own, or the one a side-path row waits to take.
export const logical = (row: CatalogFile): string => row.targetPath ?? row.path;

// Code-point order, which is PostgreSQL's `collate "C"` (UTF-8 byte) order; `<` on strings compares
// UTF-16 code units and puts astral characters before U+E000–U+FFFF.
export const comparePaths = (a: string, b: string): number => {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
};

export const byPath = (a: Row, b: Row) => comparePaths(a.path, b.path);

/** The error PostgreSQL's driver raises for a CHECK violation: `cause` carries code and constraint. */
const checkViolation = (constraint: string, relation = 'files'): Error => {
  const message = `new row for relation "${relation}" violates check constraint "${constraint}"`;
  return new Error(message, {
    cause: Object.assign(new Error(message), { code: '23514', constraint }),
  });
};

/** The `files` table's CHECKs (`schema/files.ts`), so a row the database refuses is refused here. */
export const assertRowShape = (row: Row): void => {
  const folder = row.kind === 'folder';
  const violated: Record<string, boolean> = {
    files_folder_is_ready: folder && row.status !== 'ready',
    files_path_shape: !/^[^/\p{Cc}]+(\/[^/\p{Cc}]+)*$/u.test(row.path),
    files_path_no_dot_segments: /(^|\/)\.\.?(\/|$)/.test(row.path),
    files_storage_key_iff_file: !folder !== (row.storageKey !== null),
    files_file_has_object_id: !folder && (row.objectId ?? null) === null,
    // `btrim` strips spaces only.
    files_storage_key_not_blank: row.storageKey?.replaceAll(' ', '') === '',
    files_size_non_negative: row.sizeBytes < 0,
    files_folder_has_no_content: folder && (row.sizeBytes !== 0 || row.contentType !== null),
    files_status_valid: !fileStatuses.includes(row.status),
    files_area_valid: row.area !== undefined && !storageAreas.includes(row.area),
    files_sha256_shape: typeof row.sha256 === 'string' && !/^[0-9a-f]{64}$/.test(row.sha256),
    files_side_path_target:
      (logical(row) !== row.path) !== isSidePath(row.path) ||
      (logical(row) !== row.path && row.status === 'ready'),
  };
  const constraint = Object.keys(violated).find((name) => violated[name]);
  if (constraint !== undefined) throw checkViolation(constraint);
};

/** The `skills` table's CHECKs (`schema/skills.ts`); `btrim` strips spaces only. */
export const assertSkillShape = (input: {
  readonly name: string;
  readonly skillMd: string;
}): void => {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(input.name)) {
    throw checkViolation('skills_name_shape', 'skills');
  }
  if (input.skillMd.replaceAll(' ', '') === '') {
    throw checkViolation('skills_skill_md_not_blank', 'skills');
  }
};

export const later = <T>(fn: () => T): Promise<T> => Promise.resolve().then(fn);

export const byName = (a: CatalogSkill, b: CatalogSkill) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

export interface SkillState {
  readonly skills: Map<string, CatalogSkill>;
  /** Newest first, keyed by skill id, so a deleted and recreated skill restarts at 1. */
  readonly revisions: Map<string, StoredRevision[]>;
  readonly assignments: Map<string, Set<string>>;
}

export interface StoredRevision extends CatalogSkillRevision {
  readonly id: string;
  readonly pending: boolean;
}

export const served = (r: StoredRevision): CatalogSkillRevision => ({
  number: r.number,
  fileCount: r.fileCount,
  publishedAt: r.publishedAt,
});

/** A workspace catalog plus the test hook that stands in for an agent version assigning a skill. */
export type InMemoryWorkspaceCatalog = ResourceCatalogRepository & {
  /** Test hook, not part of the port: record that `agentId` uses the skill, as `agent_skills` does. */
  assignSkill(name: string, agentId: string): void;
  /** Test hook, not part of the port: `agentId` no longer uses the skill. */
  unassignSkill(name: string, agentId: string): void;
  /**
   * Test hook: assign as an agent write does, which refuses (`false`, nothing assigned) a skill
   * whose delete is pending.
   */
  tryAssignSkill(name: string, agentId: string): boolean;
  /** Test hook, not part of the port: date the skill's pending revisions past the stale window. */
  ageSkillRevisions(name: string): void;
  /**
   * Test hook, not part of the port: put a file row in any state, the way a raw insert does in
   * PostgreSQL. It enforces the same unique keys and throws on a duplicate.
   */
  seed(input: {
    readonly path: string;
    readonly status: FileStatus;
    readonly ownerPrincipalId: string;
    readonly objectId: string;
  }): void;
};
