/**
 * The skills part of the adopt stage (the storage design, §06): for every workspace, give each skill
 * kept in the old forms a catalog row and file rows. The old forms are a skill record object
 * (`skill-meta/<name>.json`), a bare object prefix (`skills/<name>/…`) and a published revision's bare
 * prefix (`skill-revisions/<name>/<n>/…`). The conversions are the ones a list, a read and a write
 * already make lazily, so this only runs them for every skill up front. It never replaces a row, so
 * it is safe to repeat and to run on two instances at once.
 *
 * A skill whose delete is pending (the row's mark, or a legacy `skill-deletes/<name>.json` marker)
 * is left alone, and a revision prefix is moved only when the revision has a record: a delete clears
 * only the rows of the revisions it knows of. A delete that starts while a skill is being moved
 * wins: the rows this pass wrote are removed again, and the delete sweeps the rows once more after
 * it has removed the bare prefix.
 *
 * The pass is recorded as a `skills` run: `legacyRows` is the number of old objects still left in
 * any workspace afterwards (the guard that removes the skill bridges reads it), `mismatches` the
 * workspaces that failed. A pass that moved nothing and found what the last one found is not
 * recorded again, so a start-up with nothing to do writes nothing.
 */
import type { Logger } from '@agent-workspace/core/telemetry';

import {
  SKILL_FILES_PREFIX,
  SKILL_META_PREFIX,
  SKILL_REVISIONS_PREFIX,
  skillNameFromMetaKey,
  skillRevisionRowFolder,
  skillRowFolder,
} from '../skills/keys';
import { pendingSkillDelete, skillSyncContext } from '../skills/pending-delete';
import { listSkillsWithIds, problemCode } from '../skills/service';
import { ensureSkillRows, type SkillRowsAccess, type SkillRowsWriter } from '../skills/tree';
import type { CatalogSkill, MigrationRuns, SkillObjects, SkillsAdoptCatalog } from './store';

export interface SkillsAdoptDependencies {
  readonly workspaceIds: () => Promise<readonly string[]>;
  /** Rejects for a workspace that no longer exists. */
  readonly objects: (workspaceId: string) => SkillObjects;
  readonly catalog: (workspaceId: string) => Promise<SkillsAdoptCatalog>;
  /** The workspace owner's principal, or `null` when it has none. */
  readonly ownerPrincipalId: (workspaceId: string) => Promise<string | null>;
  readonly storage: SkillRowsAccess['storage'];
  readonly runs: MigrationRuns;
  readonly log: Logger;
}

export interface SkillsAdoptReport {
  readonly workspaces: number;
  /** Skills that have a catalog row after the pass. */
  readonly skills: number;
  /** Old skill files this pass found to move into rows. */
  readonly moved: number;
  /** Old objects still left: bytes of a skill with no row, a record not yet in its column. */
  readonly remaining: number;
  /** Workspaces whose conversion failed; the next run retries them. */
  readonly failed: number;
}

type Counts = { -readonly [K in keyof SkillsAdoptReport]: number };

/** The files under `prefix` that `counted` accepts, listed a page at a time. */
async function countFiles(
  objects: SkillObjects,
  prefix: string,
  counted: (key: string) => boolean = () => true,
): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await objects.listPage(prefix, {
      recursive: true,
      ...(cursor === undefined ? {} : { cursor }),
    });
    count += page.entries.filter((entry) => entry.kind === 'file' && counted(entry.key)).length;
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  return count;
}

/** The old skill objects of one workspace that a lazy conversion has not moved. */
async function countRemaining(
  objects: SkillObjects,
  rows: readonly CatalogSkill[],
): Promise<number> {
  const withMeta = new Set(rows.filter((row) => row.meta !== null).map((row) => row.name));
  const records = await countFiles(objects, SKILL_META_PREFIX, (key) => {
    const name = skillNameFromMetaKey(key);
    return name !== null && !withMeta.has(name);
  });
  const bytes = await Promise.all(
    [SKILL_FILES_PREFIX, SKILL_REVISIONS_PREFIX].map((prefix) => countFiles(objects, prefix)),
  );
  return records + bytes.reduce((sum, files) => sum + files, 0);
}

async function removeRows(writer: SkillRowsWriter, folder: string): Promise<void> {
  const gone = await writer.storage.remove({ workspaceId: writer.workspaceId }, 'skills', folder, {
    recursive: true,
  });
  if (!gone.ok && gone.code !== 'not_found') {
    throw new Error(`could not remove the rows of ${folder}: ${gone.code}`);
  }
}

/**
 * The skill's bytes, then each of its recorded revisions' bytes, moved into rows; answers how many
 * old files there were. A revision prefix with no record is left alone. When the skill is gone or
 * its delete started meanwhile, the rows are removed again: the delete's own sweep may have run
 * before they were written.
 */
async function adoptSkill(
  objects: SkillObjects,
  catalog: SkillsAdoptCatalog,
  writer: SkillRowsWriter,
  name: string,
): Promise<number> {
  const folders = [skillRowFolder(name)];
  let moved = await ensureSkillRows(objects, writer, name);
  for (const revision of await catalog.listSkillRevisions(name)) {
    moved += await ensureSkillRows(objects, writer, name, revision.number);
    folders.push(skillRevisionRowFolder(name, revision.number));
  }
  if (moved === 0) return 0;
  const live =
    (await catalog.getSkill(name)) !== null &&
    (await pendingSkillDelete(objects, catalog, name)) === null;
  if (!live) for (const folder of folders) await removeRows(writer, folder);
  return moved;
}

/** One workspace: list its skills (which gives each a row), then move every live skill's bytes. */
async function adoptWorkspace(
  deps: SkillsAdoptDependencies,
  workspaceId: string,
  report: Counts,
): Promise<void> {
  const objects = deps.objects(workspaceId);
  const catalog = await deps.catalog(workspaceId);
  const owner = await deps.ownerPrincipalId(workspaceId);
  if (owner !== null) {
    const principal = { ownerPrincipalId: owner, userId: null };
    // Gives every listed skill its row and fills its record column from the old object.
    const listed = await listSkillsWithIds(objects, catalog, principal, {
      storage: deps.storage,
      workspaceId,
    });
    if (listed.status !== 200) {
      report.failed += 1;
      deps.log.warn('[storage] adopting legacy skills failed for a workspace', {
        stage: 'skills',
        code: problemCode(listed) ?? 'unknown',
      });
    }
  }
  // The rows, read once after the list made them, and every name whose delete is pending.
  const { existing, pendingDeletes } = await skillSyncContext(objects, catalog);
  if (owner !== null) {
    const writer = {
      storage: deps.storage,
      workspaceId,
      principal: { principalId: owner, userId: null },
    };
    // ADR-0077 D3: a skill whose delete is pending is being removed; moving its bare files into
    // rows here would leave them behind once the delete drops the catalog row.
    for (const skill of existing) {
      if (!pendingDeletes.has(skill.name)) {
        report.moved += await adoptSkill(objects, catalog, writer, skill.name);
      }
    }
  }
  report.skills += existing.length;
  report.remaining += await countRemaining(objects, existing);
}

// @story US-STO-13
// storage-bridge(#1699): old skill forms, until the skill bridges are removed
export async function runSkillsAdoptStage(
  deps: SkillsAdoptDependencies,
): Promise<SkillsAdoptReport> {
  const { log } = deps;
  const report: Counts = { workspaces: 0, skills: 0, moved: 0, remaining: 0, failed: 0 };
  for (const workspaceId of await deps.workspaceIds()) {
    report.workspaces += 1;
    try {
      await adoptWorkspace(deps, workspaceId, report);
    } catch (error) {
      // A workspace that is gone, or a store that fails, must not stop the others. Only the error
      // name is logged: the message can carry connection text.
      report.failed += 1;
      log.warn('[storage] adopting legacy skills failed for a workspace', {
        stage: 'skills',
        name: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  const run = {
    rowsChecked: report.skills,
    legacyRows: report.remaining,
    mismatches: report.failed,
  };
  const last = await deps.runs.latest('skills');
  const unchanged =
    last !== null &&
    last.rowsChecked === run.rowsChecked &&
    last.legacyRows === run.legacyRows &&
    last.mismatches === run.mismatches;
  if (report.moved > 0 || !unchanged) await deps.runs.record({ stage: 'skills', ...run });
  log.info('[storage] adopted legacy skills', { stage: 'skills', ...report });
  return report;
}
