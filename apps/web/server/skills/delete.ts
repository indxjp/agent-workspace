/**
 * `DELETE /api/skills/:name` — remove a skill nothing is assigned to (S-12, ADR-0077).
 *
 * A skill lives in two places: its catalog row (`skills`, which agent assignments reference) and
 * its bytes in the workspace object store (`skills/<name>/…` plus the platform record
 * `skill-meta/<name>.json`). The two cannot share one transaction, so the delete is ordered to be
 * recoverable instead:
 *
 * 1. A pending-delete marker (`skill-deletes/<name>.json`, `pending-delete.ts`) is written first,
 *    recording the row's owner. While it exists, the catalog sync in `GET /api/skills` and
 *    `GET /api/skills/:name` never inserts a row for the name, so nothing can bring the row back or
 *    claim it; and the route's ownership check reads the owner from it once the row is gone, so
 *    the owning Builder can retry.
 * 2. The catalog row goes next, in one transaction with the assignment check
 *    (`ResourceCatalogRepository.deleteSkill`). An assigned skill is refused there with
 *    `409 skill_in_use` naming every agent; the marker is removed again and nothing else is
 *    touched.
 * 3. The skill's files go, then its platform record. The row is swept once more, in case a sync
 *    that looked before the marker existed inserted one, and the marker goes last. A delete
 *    interrupted anywhere after step 1 leaves the marker, and retrying `DELETE` finishes the job.
 */
import { formatInUseReferrer } from '@indx-workspace/contracts';
import type { ResourceCatalogRepository } from '@agent-workspace/core/db';

import { problem, type ApiResult } from './handlers';
import { skillFilesPrefix, skillMetaKey } from './keys';
import type { ObjectStore } from './object-store-bridge';
import {
  clearPendingSkillDelete,
  readPendingSkillDelete,
  writePendingSkillDelete,
} from './pending-delete';
import { walkFiles } from './tree';

/** `204` once the skill's row and bytes are gone; `409 skill_in_use`; `404 skill_not_found`. */
export async function deleteSkill(
  store: ObjectStore,
  catalog: ResourceCatalogRepository,
  name: string,
): Promise<ApiResult> {
  const pending = await readPendingSkillDelete(store, name);
  if (pending === null) {
    const row = (await catalog.listSkills()).find((skill) => skill.name === name);
    await writePendingSkillDelete(store, name, {
      ownerPrincipalId: row === undefined ? null : row.ownerPrincipalId,
    });
  }
  const removed = await catalog.deleteSkill(name);
  if (removed.kind === 'in-use') {
    await clearPendingSkillDelete(store, name);
    return problem(
      409,
      'skill_in_use',
      `The skill ${JSON.stringify(name)} is still assigned. Unassign it from every agent in ` +
        'details, then retry.',
      removed.agentIds.map((id) => formatInUseReferrer({ kind: 'agent', id })),
    );
  }

  const files = await walkFiles(store, skillFilesPrefix(name));
  const meta = await store.get(skillMetaKey(name));
  if (removed.kind === 'not-found' && files.length === 0 && meta === null) {
    await clearPendingSkillDelete(store, name);
    return problem(404, 'skill_not_found', 'No skill has that name.');
  }
  for (const file of files) await store.delete(file.key);
  await store.delete(skillMetaKey(name));
  // A sync that read the platform record before the marker existed may have inserted a row since
  // step 2; with the record gone, no later sync can. An assignment to such a row cannot be older
  // than this request, so an `in-use` answer here is left for the next delete to report.
  await catalog.deleteSkill(name);
  await clearPendingSkillDelete(store, name);
  return { status: 204, kind: 'json', body: null };
}
