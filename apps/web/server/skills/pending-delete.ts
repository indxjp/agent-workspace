/**
 * The pending delete of `DELETE /api/skills/:name`, and the catalog sync that respects it
 * (issue #240 review, ADR-0077 D3).
 *
 * `GET /api/skills` and `GET /api/skills/:name` upsert a catalog row for every skill whose
 * `skill-meta/<name>.json` they find. A delete marks the skill's row (`skills.pending_delete`: the
 * owner and the revision numbers) before it removes any bytes, and removes the row last. While the
 * mark exists the sync never answers with the skill, so nothing brings it back between the two
 * steps, and the mark records the owner, so the owning Builder can finish an interrupted delete.
 */
import {
  parsePendingSkillDelete,
  type CatalogSkill,
  type PendingSkillDelete,
  type ResourceCatalogRepository,
} from '@agent-workspace/core/db';

import { SKILL_DELETE_PREFIX, skillDeleteMarkerKey, skillMetaKey } from './keys';
import type { SkillObjects } from '../storage/store';

/**
 * The marker object an earlier release wrote for a pending delete, or `null` when there is none.
 * Nothing writes it any more.
 */
// storage-bridge(#1699): read `skill-deletes/<name>.json` until the marker objects are removed (#1676)
export async function readLegacyPendingSkillDelete(
  store: SkillObjects,
  name: string,
): Promise<PendingSkillDelete | null> {
  const object = await store.get(skillDeleteMarkerKey(name));
  if (object === null) return null;
  try {
    return parsePendingSkillDelete(JSON.parse(Buffer.from(object.body).toString('utf8')));
  } catch {
    // An unreadable marker still marks the delete as pending; it just proves no owner.
    return parsePendingSkillDelete(null);
  }
}

/** Remove the legacy marker of `name`: the delete finished, or was refused before it changed anything. */
// storage-bridge(#1699): the marker of a skill whose delete ended must not hide a later skill of that name
export async function clearLegacyPendingSkillDelete(
  store: SkillObjects,
  name: string,
): Promise<void> {
  await store.delete(skillDeleteMarkerKey(name));
}

/**
 * The pending delete of `name`: the row's column, else the legacy marker object. A legacy marker
 * found beside a row that has no column value is copied to the column, and the marker object stays.
 * The copy follows the rule of a fresh delete: a skill an agent has assigned is not marked, so its
 * legacy marker does not count (`null`), and the skill stays listed and usable.
 */
export async function pendingSkillDelete(
  store: SkillObjects,
  catalog: ResourceCatalogRepository,
  name: string,
): Promise<PendingSkillDelete | null> {
  const row = (await catalog.listSkills()).find((skill) => skill.name === name);
  const marked = row?.pendingDelete ?? null;
  if (marked !== null) return marked;
  const legacy = await readLegacyPendingSkillDelete(store, name);
  if (legacy === null || row === undefined) return legacy;
  return (await catalog.backfillSkillPendingDelete(name, legacy)) ? legacy : null;
}

/** The names of every skill with a delete pending in this workspace. */
async function pendingSkillDeleteNames(
  store: SkillObjects,
  catalog: ResourceCatalogRepository,
  existing: readonly CatalogSkill[],
): Promise<ReadonlySet<string>> {
  const names = new Set(
    existing.filter((row) => row.pendingDelete !== null).map((row) => row.name),
  );
  // storage-bridge(#1699): names pending only as legacy marker objects
  const prefix = `${SKILL_DELETE_PREFIX}/`;
  const suffix = '.json';
  for (const entry of await store.list(SKILL_DELETE_PREFIX)) {
    if (entry.kind !== 'file' || !entry.key.startsWith(prefix) || !entry.key.endsWith(suffix)) {
      continue;
    }
    const name = entry.key.slice(prefix.length, entry.key.length - suffix.length);
    // A marker beside a row is only a pending delete if the skill is not in use (and then the
    // column is filled); a marker with no row hides the name.
    if (existing.some((row) => row.name === name)) {
      if ((await pendingSkillDelete(store, catalog, name)) !== null) names.add(name);
    } else names.add(name);
  }
  return names;
}

/** What a read route would write to the catalog for one listed skill. */
export type SkillCatalogSyncInput = Parameters<ResourceCatalogRepository['putSkill']>[0];

/** What {@link syncSkillCatalogRow} needs to know, read once per request. */
export interface SkillSyncContext {
  readonly existing: readonly CatalogSkill[];
  readonly pendingDeletes: ReadonlySet<string>;
}

export async function skillSyncContext(
  store: SkillObjects,
  catalog: ResourceCatalogRepository,
): Promise<SkillSyncContext> {
  const existing = await catalog.listSkills();
  return { existing, pendingDeletes: await pendingSkillDeleteNames(store, catalog, existing) };
}

/**
 * Upsert the catalog row a read route found bytes for, unless a delete is pending, and return its
 * id — or `null` when the skill is being deleted and so has nothing to answer with.
 *
 * - A pending delete never gets a row inserted, and one that has passed its in-use check (it holds
 *   a mark) is left out, so a half-deleted skill is neither listed nor handed to its reader.
 * - A row this call inserted is checked once more. If the skill's platform record is gone or a
 *   delete started meanwhile, the sync raced a delete, so the row it inserted is removed again.
 *   Together with the delete's own final sweep, no sync leaves a row behind a delete.
 */
export async function syncSkillCatalogRow(
  store: SkillObjects,
  catalog: ResourceCatalogRepository,
  input: SkillCatalogSyncInput,
  context: SkillSyncContext,
): Promise<string | null> {
  if (context.pendingDeletes.has(input.name)) return null;
  const existing = context.existing.find((row) => row.name === input.name);
  const row = await catalog.putSkill(input);
  if (existing?.id === row.id) return row.id;
  const raced =
    (await store.get(skillMetaKey(input.name))) === null ||
    (await pendingSkillDelete(store, catalog, input.name)) !== null;
  if (!raced) return row.id;
  await catalog.deleteSkill(input.name);
  return null;
}
