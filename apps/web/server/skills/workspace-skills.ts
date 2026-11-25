/**
 * The skills of a workspace, as another context may handle them: list them, read one's files, make
 * one from files, publish new files for one, install the built-ins, delete one. It is the skills routes' own sequence
 * (`service.ts`, `handlers.ts`, `builtin.ts`, `delete.ts`), called with a workspace id the caller
 * already decided on instead of one read from a request, so the catalog row, the reservation, the
 * rows and the platform record are written exactly as `POST /api/skills` writes them.
 *
 * The Agent Store demo is the caller (`demo/provision`): a template's skills are seeded from the
 * deployment's own seed, and a visitor's copy gets the template's skills. The composition root hands
 * it {@link createWorkspaceSkills}; the demo context sees only the {@link WorkspaceSkills} type,
 * re-exported by the agents context's entry.
 */
import { isBuiltinSkillName } from '@indx-workspace/contracts/skills';

import type { Caller } from '../identity';
import type { SkillObjects, StorageService } from '../storage-and-sharing';
import { ensureBuiltinSkills } from './builtin';
import { deleteSkill } from './delete';
import { exportSkill, type SkillExportFile } from './handlers';
import { withSkillMetaColumn } from './meta-column';
import type { SkillCatalog } from './ports';
import { importSkillWithId, problemCode, publishSkillRevisionWithId } from './service';

/** One file of a skill, at its path inside the skill's folder (`SKILL.md`, `scripts/run.mjs`). */
export interface WorkspaceSkillFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** Who a skill made in a workspace belongs to: a membership principal there. */
export type WorkspaceSkillOwner = Pick<Caller, 'principalId' | 'userId'>;

/** What making a skill came to: its catalog id, or the problem code the import answered. */
export type WorkspaceSkillCreated =
  | { readonly kind: 'created'; readonly id: string }
  /** The workspace already has a skill with the name; its id. Its files are left as they are. */
  | { readonly kind: 'exists'; readonly id: string }
  | { readonly kind: 'refused'; readonly code: string };

/** What publishing new files for a skill came to. */
export type WorkspaceSkillPublished =
  { readonly kind: 'published' } | { readonly kind: 'refused'; readonly code: string };

/** What deleting a skill came to. */
export type WorkspaceSkillRemoved =
  | { readonly kind: 'removed' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'in-use' }
  | { readonly kind: 'refused'; readonly code: string };

export interface WorkspaceSkills {
  /** The id and name of every skill of the workspace that is not being deleted. */
  list(workspaceId: string): Promise<readonly { readonly id: string; readonly name: string }[]>;
  /** Every file of the skill `name`, or `null` when the workspace has no such skill. */
  files(workspaceId: string, name: string): Promise<readonly WorkspaceSkillFile[] | null>;
  /** Make the skill `name` from `files` (which must hold `SKILL.md`), owned by `owner`. */
  create(
    workspaceId: string,
    owner: WorkspaceSkillOwner,
    skill: { readonly name: string; readonly files: readonly WorkspaceSkillFile[] },
  ): Promise<WorkspaceSkillCreated>;
  /**
   * Make `files` the whole current content of the existing skill `name` and freeze them as its next
   * revision, as `POST /api/skills/:name/revisions` does. The skill keeps its id, so an agent it is
   * assigned to follows the new files.
   */
  publish(
    workspaceId: string,
    owner: WorkspaceSkillOwner,
    skill: { readonly name: string; readonly files: readonly WorkspaceSkillFile[] },
  ): Promise<WorkspaceSkillPublished>;
  /** Install the platform's built-in skills among `names` (`BUILTIN_SKILL_NAMES`); others are ignored. */
  installBuiltins(
    workspaceId: string,
    owner: WorkspaceSkillOwner,
    names: readonly string[],
  ): Promise<void>;
  /** Delete the skill `name`: its files, its record and its row. Refused while an agent has it. */
  remove(workspaceId: string, name: string): Promise<WorkspaceSkillRemoved>;
}

/** A file as the skills routes take it: its bytes as base64. */
const encodeFile = (file: WorkspaceSkillFile) => ({
  path: file.path,
  contentBase64: Buffer.from(file.bytes).toString('base64'),
});

export interface WorkspaceSkillsDependencies {
  /** The workspace's skill objects (the files of a skill stored before the catalog held rows). */
  readonly objects: (workspaceId: string) => SkillObjects;
  /** The workspace's skills catalog. */
  readonly catalog: (workspaceId: string) => Promise<SkillCatalog>;
  /** The catalog service the skill rows are saved, read and removed through. */
  readonly storage: Pick<StorageService, 'list' | 'open' | 'remove' | 'save'>;
}

export function createWorkspaceSkills(deps: WorkspaceSkillsDependencies): WorkspaceSkills {
  const rowsOf = (workspaceId: string) => ({ storage: deps.storage, workspaceId });
  const principalOf = (workspaceId: string, owner: WorkspaceSkillOwner) => ({
    workspaceId,
    ownerPrincipalId: owner.principalId,
    userId: owner.userId,
  });

  async function idOf(workspaceId: string, name: string): Promise<string | null> {
    const row = await (await deps.catalog(workspaceId)).getSkill(name);
    return row === null || row.pendingDelete !== null ? null : row.id;
  }

  return {
    async list(workspaceId) {
      const rows = await (await deps.catalog(workspaceId)).listSkills();
      return rows
        .filter((row) => row.pendingDelete === null)
        .map((row) => ({ id: row.id, name: row.name }));
    },

    async files(workspaceId, name) {
      const store = withSkillMetaColumn(deps.objects(workspaceId), await deps.catalog(workspaceId));
      const exported = await exportSkill(store, name, rowsOf(workspaceId));
      if (exported.status === 404) return null;
      if (exported.status !== 200) {
        throw new Error(`the skill ${name} could not be read: ${problemCode(exported) ?? ''}`);
      }
      const { files } = (exported.body as { skill: { files: readonly SkillExportFile[] } }).skill;
      return files.map((file) => ({
        path: file.path,
        bytes: new Uint8Array(Buffer.from(file.contentBase64, 'base64')),
      }));
    },

    async create(workspaceId, owner, skill) {
      const imported = await importSkillWithId(
        deps.objects(workspaceId),
        await deps.catalog(workspaceId),
        principalOf(workspaceId, owner),
        { name: skill.name, files: skill.files.map(encodeFile) },
        rowsOf(workspaceId),
      );
      if (imported.status === 201) {
        return { kind: 'created', id: (imported.body as { skill: { id: string } }).skill.id };
      }
      const code = problemCode(imported) ?? String(imported.status);
      if (code === 'skill_already_exists') {
        const id = await idOf(workspaceId, skill.name);
        if (id !== null) return { kind: 'exists', id };
      }
      return { kind: 'refused', code };
    },

    async publish(workspaceId, owner, skill) {
      const published = await publishSkillRevisionWithId(
        deps.objects(workspaceId),
        await deps.catalog(workspaceId),
        principalOf(workspaceId, owner),
        skill.name,
        { files: skill.files.map(encodeFile) },
        rowsOf(workspaceId),
      );
      if (published.status === 201) return { kind: 'published' };
      return { kind: 'refused', code: problemCode(published) ?? String(published.status) };
    },

    async installBuiltins(workspaceId, owner, names) {
      const builtins = names.filter(isBuiltinSkillName);
      if (builtins.length === 0) return;
      await ensureBuiltinSkills(
        deps.objects(workspaceId),
        await deps.catalog(workspaceId),
        principalOf(workspaceId, owner),
        builtins,
        rowsOf(workspaceId),
      );
    },

    async remove(workspaceId, name) {
      const removed = await deleteSkill(
        deps.objects(workspaceId),
        await deps.catalog(workspaceId),
        name,
        rowsOf(workspaceId),
      );
      if (removed.status === 204) return { kind: 'removed' };
      const code = problemCode(removed) ?? String(removed.status);
      if (code === 'skill_not_found') return { kind: 'not-found' };
      if (code === 'skill_in_use') return { kind: 'in-use' };
      return { kind: 'refused', code };
    },
  };
}
