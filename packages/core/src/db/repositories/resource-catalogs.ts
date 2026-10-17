import { and, asc, eq, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { agentSkills } from '../schema/agent-skills.js';
import { files, type FileKind } from '../schema/files.js';
import { skills } from '../schema/skills.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

export interface CatalogFile {
  readonly id: string;
  readonly path: string;
  readonly kind: FileKind;
  readonly storageKey: string | null;
  readonly sizeBytes: number;
  readonly contentType: string | null;
  /** Compatibility attribution for a membership principal. */
  readonly createdBy: string | null;
  /** Exact owner; an upsert at an existing path never transfers it. */
  readonly ownerPrincipalId: string;
}

export interface CatalogSkill {
  readonly id: string;
  readonly name: string;
  readonly skillMd: string;
  readonly enabled: boolean;
  /** Compatibility attribution for a membership principal. */
  readonly createdBy: string | null;
  /** Exact owner; an upsert of an existing name never transfers it. */
  readonly ownerPrincipalId: string;
}

/**
 * What deleting a skill's catalog row can produce. `in-use` names every agent the skill is still
 * assigned to, and nothing is deleted; an assignment is never cascaded away by a skill delete.
 */
export type DeleteCatalogSkillOutcome =
  | { readonly kind: 'deleted'; readonly skill: CatalogSkill }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'in-use'; readonly agentIds: readonly string[] };

export interface ResourceCatalogRepository {
  listFiles(): Promise<readonly CatalogFile[]>;
  putFile(
    input: Omit<CatalogFile, 'id' | 'createdBy'> & { readonly createdBy?: string | null },
  ): Promise<CatalogFile>;
  /**
   * Ownership and compatibility attribution are excluded from `input`: a rename changes the row's
   * path and content metadata, never who owns or originally created it.
   */
  renameFile(
    path: string,
    input: Omit<CatalogFile, 'id' | 'path' | 'createdBy' | 'ownerPrincipalId'> & { path: string },
  ): Promise<CatalogFile | null>;
  deleteFile(path: string): Promise<void>;
  /**
   * W9-FILES-131: rewrite every row whose path is `oldPrefix` itself, or lies under it
   * (`oldPrefix/…`, however deep), replacing that leading segment with `newPrefix` — in one
   * transaction, and by `UPDATE` rather than delete-then-insert, so every row keeps its `id` and
   * every `agent_files`/`project_files` grant pointing at it survives untouched. A `file` row's
   * `storage_key` is rewritten the same way (folders have none to touch). Rows outside the prefix,
   * and a sibling whose path merely starts with the same characters (`docs2/x.txt` under a prefix
   * of `docs`), are never touched — see this method's implementation for the boundary check.
   * Matches zero rows without error when nothing in the catalog is under `oldPrefix`, which is
   * what makes retrying a subtree move after this step already ran a no-op rather than a failure.
   *
   * Optional, not because the real repository ever omits it (`createDatabaseResourceCatalogRepositoryProvider`
   * below always implements both new methods), but because a narrower test double elsewhere in the
   * tree implements only the file operations it needs — making these two methods required on the
   * interface would be a type-only break of code this task does not own, for a capability that
   * code never calls. `apps/web/server/files/handlers.ts`'s `moveSubtree` calls this optionally for
   * exactly that reason.
   */
  renameFilesByPrefix?(oldPrefix: string, newPrefix: string): Promise<readonly CatalogFile[]>;
  /**
   * W9-FILES-131: delete every row whose path is `prefix` itself or lies under it, in one
   * statement. The same prefix boundary as {@link renameFilesByPrefix} applies. A no-op, not an
   * error, when nothing in the catalog is under `prefix`. Optional for the same reason.
   */
  deleteFilesByPrefix?(prefix: string): Promise<void>;
  listSkills(): Promise<readonly CatalogSkill[]>;
  putSkill(
    input: Omit<CatalogSkill, 'id' | 'createdBy'> & { readonly createdBy?: string | null },
  ): Promise<CatalogSkill>;
  /**
   * Delete one skill's catalog row unless an agent has it assigned. The assignment check and the
   * delete run in one transaction that locks the row, so an assignment racing the delete either
   * lands first (and is reported) or fails its foreign key.
   */
  deleteSkill(name: string): Promise<DeleteCatalogSkillOutcome>;
}

export interface ResourceCatalogRepositoryProvider {
  forScope(scope: WorkspaceScope): ResourceCatalogRepository;
}

/**
 * `path = prefix` or `path` starts with `prefix` followed by an actual `/` — never merely the
 * same leading characters. Built with `left()` rather than `LIKE`: `prefix` is workspace-supplied
 * text that can legally contain `%` or `_` (`files.ts`'s `files_path_shape` check does not forbid
 * either), and both are `LIKE` wildcards — a `LIKE ${prefix} || '/%'` pattern would silently widen
 * to match paths the prefix's literal characters never named. `left()` compares bytes, not a
 * pattern, so no character in `prefix` is special.
 *
 * The cut length is `char_length(${boundary})`, computed by Postgres on the bound parameter —
 * never JS's `.length`. `left()` counts CHARACTERS; JS `.length` counts UTF-16 code units, which
 * over-counts by one for every character outside the BMP (most emoji). `files_path_shape` (see
 * `files.ts`) explicitly permits such characters in a path, so a JS-length cut silently
 * overshoots the true boundary for them and the predicate never matches — see W9-FILES-131's
 * verification-round-2 notes for the reproduction.
 */
function pathUnderPrefix(prefix: string) {
  const boundary = `${prefix}/`;
  return sql`(${files.path} = ${prefix} or left(${files.path}, char_length(${boundary})) = ${boundary})`;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * A file or folder implies its parent folders, the rule `pathIsFolder` in
 * `apps/web/server/files/handlers.ts` applies when it reads. Every write that places a row at a
 * path (put, rename, subtree rename) calls this, so a `files('<folder>')` grant resolves without
 * a separate `mkdir` (issue #899). Each parent row takes the owner of the first placed row under
 * it. An existing row at a parent path, folder or file, is never touched.
 */
async function insertParentFolders(
  tx: Transaction,
  workspaceId: string,
  placed: readonly Pick<CatalogFile, 'path' | 'ownerPrincipalId' | 'createdBy'>[],
): Promise<void> {
  const parents = new Map<string, (typeof placed)[number]>();
  for (const row of placed) {
    const segments = row.path.split('/');
    for (let end = 1; end < segments.length; end += 1) {
      const path = segments.slice(0, end).join('/');
      if (!parents.has(path)) parents.set(path, row);
    }
  }
  if (parents.size === 0) return;
  await tx
    .insert(files)
    .values(
      [...parents].map(([path, row]) => ({
        workspaceId,
        path,
        kind: 'folder' as const,
        ownerPrincipalId: row.ownerPrincipalId,
        createdBy: row.createdBy,
      })),
    )
    .onConflictDoNothing({ target: [files.workspaceId, files.path] });
}

export function createDatabaseResourceCatalogRepositoryProvider(
  db: Database,
): ResourceCatalogRepositoryProvider {
  return {
    forScope(scope) {
      const workspaceId = requireWorkspaceScope(
        scope,
        'ResourceCatalogRepositoryProvider',
      ).workspaceId;
      return {
        async listFiles() {
          return db
            .select({
              id: files.id,
              path: files.path,
              kind: files.kind,
              storageKey: files.storageKey,
              sizeBytes: files.sizeBytes,
              contentType: files.contentType,
              createdBy: files.createdBy,
              ownerPrincipalId: files.ownerPrincipalId,
            })
            .from(files)
            .where(eq(files.workspaceId, workspaceId))
            .orderBy(asc(files.path));
        },
        async putFile(input) {
          return db.transaction(async (tx) => {
            await insertParentFolders(tx, workspaceId, [
              { ...input, createdBy: input.createdBy ?? null },
            ]);
            const rows = await tx
              .insert(files)
              .values({ workspaceId, ...input, createdBy: input.createdBy ?? null })
              .onConflictDoUpdate({
                target: [files.workspaceId, files.path],
                // Ownership and compatibility attribution are deliberately absent: a re-upload
                // updates content but never transfers the existing row.
                set: {
                  kind: input.kind,
                  storageKey: input.storageKey,
                  sizeBytes: input.sizeBytes,
                  contentType: input.contentType,
                },
              })
              .returning({
                id: files.id,
                path: files.path,
                kind: files.kind,
                storageKey: files.storageKey,
                sizeBytes: files.sizeBytes,
                contentType: files.contentType,
                createdBy: files.createdBy,
                ownerPrincipalId: files.ownerPrincipalId,
              });
            const row = rows[0];
            if (row === undefined) throw new Error('file catalog upsert returned no row');
            return row;
          });
        },
        async renameFile(path, input) {
          // Neither ownership nor compatibility attribution is part of a rename, so `set(input)`
          // cannot transfer the row, matching the invariant `putFile` keeps above.
          return db.transaction(async (tx) => {
            const rows = await tx
              .update(files)
              .set(input)
              .where(and(eq(files.workspaceId, workspaceId), eq(files.path, path)))
              .returning({
                id: files.id,
                path: files.path,
                kind: files.kind,
                storageKey: files.storageKey,
                sizeBytes: files.sizeBytes,
                contentType: files.contentType,
                createdBy: files.createdBy,
                ownerPrincipalId: files.ownerPrincipalId,
              });
            await insertParentFolders(tx, workspaceId, rows);
            return rows[0] ?? null;
          });
        },
        async deleteFile(path) {
          await db
            .delete(files)
            .where(and(eq(files.workspaceId, workspaceId), eq(files.path, path)));
        },
        async renameFilesByPrefix(oldPrefix, newPrefix) {
          // The cut point — one past `oldPrefix` itself — is computed by Postgres as
          // `char_length(${oldPrefix}) + 1`, never as JS's `oldPrefix.length + 1`. `substr`
          // counts CHARACTERS; JS `.length` counts UTF-16 code units, which over-counts by one
          // for every character outside the BMP (most emoji) and so cuts at the wrong character
          // boundary for a prefix containing one — the same class of bug `pathUnderPrefix`
          // documents above. See W9-FILES-131's verification-round-2 notes for the reproduction.
          return db.transaction(async (tx) => {
            const rows = await tx
              .update(files)
              .set({
                // `substr(text, int)`, not the two-argument `substring(text FROM ...)` form:
                // that form has a *second* overload — POSIX regexp extraction — and a bound
                // parameter's type is not always pinned to `integer` early enough to rule it out,
                // so `substring(path from $2)` silently became "search `path` for a regex
                // matching `$2`" and returned `NULL` (no match) for every row, which this method's
                // own test caught as a `NOT NULL` violation on `path`. `substr` has only the
                // integer-offset overload, so there is no second meaning to fall into.
                path: sql`${newPrefix} || substr(${files.path}, char_length(${oldPrefix}) + 1)`,
                // A folder row has no `storage_key` to rewrite; `files_storage_key_iff_file`
                // already guarantees that, so the `case` below only ever touches a file's.
                storageKey: sql`case when ${files.kind} = 'file'
                  then ${newPrefix} || substr(${files.storageKey}, char_length(${oldPrefix}) + 1)
                  else ${files.storageKey} end`,
              })
              .where(and(eq(files.workspaceId, workspaceId), pathUnderPrefix(oldPrefix)))
              .returning({
                id: files.id,
                path: files.path,
                kind: files.kind,
                storageKey: files.storageKey,
                sizeBytes: files.sizeBytes,
                contentType: files.contentType,
                createdBy: files.createdBy,
                ownerPrincipalId: files.ownerPrincipalId,
              });
            // The moved rows come back first so the parent rows never shadow `newPrefix` itself.
            await insertParentFolders(tx, workspaceId, rows);
            return rows;
          });
        },
        async deleteFilesByPrefix(prefix) {
          await db
            .delete(files)
            .where(and(eq(files.workspaceId, workspaceId), pathUnderPrefix(prefix)));
        },
        async listSkills() {
          return db
            .select({
              id: skills.id,
              name: skills.name,
              skillMd: skills.skillMd,
              enabled: skills.enabled,
              createdBy: skills.createdBy,
              ownerPrincipalId: skills.ownerPrincipalId,
            })
            .from(skills)
            .where(eq(skills.workspaceId, workspaceId))
            .orderBy(asc(skills.name));
        },
        async putSkill(input) {
          const rows = await db
            .insert(skills)
            .values({ workspaceId, ...input, createdBy: input.createdBy ?? null })
            .onConflictDoUpdate({
              target: [skills.workspaceId, skills.name],
              // Ownership and compatibility attribution are absent; see `putFile` above.
              set: { skillMd: input.skillMd, enabled: input.enabled },
            })
            .returning({
              id: skills.id,
              name: skills.name,
              skillMd: skills.skillMd,
              enabled: skills.enabled,
              createdBy: skills.createdBy,
              ownerPrincipalId: skills.ownerPrincipalId,
            });
          const row = rows[0];
          if (row === undefined) throw new Error('skill catalog upsert returned no row');
          return row;
        },
        async deleteSkill(name) {
          return db.transaction(async (tx): Promise<DeleteCatalogSkillOutcome> => {
            const locked = await tx
              .select({
                id: skills.id,
                name: skills.name,
                skillMd: skills.skillMd,
                enabled: skills.enabled,
                createdBy: skills.createdBy,
                ownerPrincipalId: skills.ownerPrincipalId,
              })
              .from(skills)
              .where(and(eq(skills.workspaceId, workspaceId), eq(skills.name, name)))
              .for('update');
            const skill = locked[0];
            if (skill === undefined) return { kind: 'not-found' };
            const assignments = await tx
              .select({ agentId: agentSkills.agentId })
              .from(agentSkills)
              .where(
                and(eq(agentSkills.workspaceId, workspaceId), eq(agentSkills.skillId, skill.id)),
              )
              .orderBy(asc(agentSkills.agentId));
            if (assignments.length > 0) {
              return { kind: 'in-use', agentIds: assignments.map((row) => row.agentId) };
            }
            await tx
              .delete(skills)
              .where(and(eq(skills.workspaceId, workspaceId), eq(skills.id, skill.id)));
            return { kind: 'deleted', skill };
          });
        },
      };
    },
  };
}
