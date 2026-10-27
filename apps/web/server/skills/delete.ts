/**
 * `DELETE /api/skills/:name` — remove a skill nothing is assigned to (S-12, ADR-0077).
 *
 * A skill lives in two places: its catalog row (`skills`, which agent assignments reference) and
 * its bytes in the workspace (`.skills/<name>…` rows, plus the bare objects of earlier releases).
 * The two cannot share one transaction, so the delete is ordered to be recoverable instead:
 *
 * 1. The row is marked first (`ResourceCatalogRepository.markSkillDeleting`), in one transaction
 *    with the assignment check. An assigned skill is refused there with `409 skill_in_use` naming
 *    every agent, and nothing else is touched. The mark (`skills.pending_delete`) holds the row's
 *    owner and every revision number. While it exists the catalog sync in `GET /api/skills` and
 *    `GET /api/skills/:name` leaves the skill out and no revision can be published to it, and the
 *    route's ownership check reads the owner from the row, so the owning Builder can retry.
 * 2. The skill's files go, then its platform record.
 * 3. The row goes last. A delete interrupted anywhere after step 1 leaves the mark, and retrying
 *    `DELETE` finishes the job.
 *
 * A skill whose delete an earlier release recorded as a marker object (no row, or a row without a
 * mark) is finished the same way; its marker object is removed with it.
 */
import { formatInUseReferrer } from '@indx-workspace/contracts';
import type { ResourceCatalogRepository } from '@agent-workspace/core/db';

import type { ApiResult } from '../http/result';
import { problem } from './handlers';
import {
  skillFilesPrefix,
  skillMetaKey,
  skillRevisionRowFolder,
  skillRevisionsPrefix,
  skillRowFolder,
} from './keys';
import type { SkillObjects } from '../storage/store';
import { withSkillMetaColumn } from './meta-column';
import { clearLegacyPendingSkillDelete, pendingSkillDelete } from './pending-delete';
import { walkFiles, type SkillRowsAccess } from './tree';

/** `204` once the skill's row and bytes are gone; `409 skill_in_use`; `404 skill_not_found`. */
export async function deleteSkill(
  objects: SkillObjects,
  catalog: ResourceCatalogRepository,
  name: string,
  rows?: SkillRowsAccess,
): Promise<ApiResult> {
  const store = withSkillMetaColumn(objects, catalog);
  const earlier = await pendingSkillDelete(store, catalog, name);
  const marked = await catalog.markSkillDeleting(name);
  if (marked.kind === 'in-use') {
    // A mark that stands is never undone: only a marker that did not count (no mark) is cleared.
    if (earlier === null) await clearLegacyPendingSkillDelete(store, name);
    return problem(409, 'skill_in_use', inUseMessage(name), inUseReferrers(marked.agentIds));
  }
  // The revision numbers are only readable while the skill row exists, so the mark keeps them.
  const revisions = new Set([
    ...(earlier?.revisions ?? []),
    ...(marked.kind === 'marked' ? marked.pending.revisions : []),
  ]);

  const removedRows = await removeRowFolders(name, revisions, rows);
  // storage-bridge(#1699): a skill stored as a bare object prefix is deleted from the store
  const files = await walkFiles(store, skillFilesPrefix(name));
  const meta = await store.get(skillMetaKey(name));
  if (marked.kind === 'not-found' && removedRows === 0 && files.length === 0 && meta === null) {
    await clearLegacyPendingSkillDelete(store, name);
    return problem(404, 'skill_not_found', 'No skill has that name.');
  }
  for (const file of files) await store.delete(file.key);
  for (const file of await walkFiles(store, skillRevisionsPrefix(name))) {
    await store.delete(file.key);
  }
  // storage-bridge(#1699): the skills adopt stage may have moved the bare prefix into rows after the
  // first sweep (it read the skill before the mark); sweeping again removes them.
  await removeRowFolders(name, revisions, rows);
  await store.delete(skillMetaKey(name));
  // A sync that read the platform record before the mark existed may have inserted a row for a
  // skill that had none; with the record gone, no later sync can. An assignment to such a row cannot
  // be older than this request, but one made to the marked row after step 1 can be: it is refused
  // here, and the retry after it is unassigned finishes the delete.
  const removed = await catalog.deleteSkill(name);
  if (removed.kind === 'in-use') {
    return problem(409, 'skill_in_use', inUseMessage(name), inUseReferrers(removed.agentIds));
  }
  await clearLegacyPendingSkillDelete(store, name);
  return { status: 204, body: null };
}

/** Remove the skill's row folder and each revision's; answers how many rows went. */
async function removeRowFolders(
  name: string,
  revisions: ReadonlySet<number>,
  rows: SkillRowsAccess | undefined,
): Promise<number> {
  if (rows === undefined) return 0;
  let removed = 0;
  const folders = [
    skillRowFolder(name),
    ...[...revisions].map((revision) => skillRevisionRowFolder(name, revision)),
  ];
  for (const folder of folders) {
    const gone = await rows.storage.remove({ workspaceId: rows.workspaceId }, 'skills', folder, {
      recursive: true,
    });
    if (gone.ok) removed += gone.removed;
    else if (gone.code !== 'not_found') {
      throw new Error(`could not remove the rows of skill ${name}: ${gone.code}`);
    }
  }
  return removed;
}

const inUseMessage = (name: string): string =>
  `The skill ${JSON.stringify(name)} is still assigned. Unassign it from every agent in ` +
  'details, then retry.';

const inUseReferrers = (agentIds: readonly string[]): string[] =>
  agentIds.map((id) => formatInUseReferrer({ kind: 'agent', id }));
