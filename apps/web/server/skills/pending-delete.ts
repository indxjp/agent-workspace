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
import { skillMetaKey } from './keys';
import type { PendingSkillDelete, SkillCatalog, SkillRow, SkillRowInput } from './ports';
import { readWhole } from '../storage/objects';
import type { SkillObjects } from '../storage-and-sharing';

/** The pending delete of `name`: the mark on its row, or `null`. */
export async function pendingSkillDelete(
  catalog: SkillCatalog,
  name: string,
): Promise<PendingSkillDelete | null> {
  // Read by name: a sync asks this once per skill, so listing every row here would make a pass over
  // n skills read the whole table n times (#1925 item 5).
  return (await catalog.getSkill(name))?.pendingDelete ?? null;
}

/** What a read route would write to the catalog for one listed skill. */
export type SkillCatalogSyncInput = SkillRowInput;

/** What {@link syncSkillCatalogRow} needs to know, read once per request. */
export interface SkillSyncContext {
  readonly existing: readonly SkillRow[];
  readonly pendingDeletes: ReadonlySet<string>;
}

export async function skillSyncContext(catalog: SkillCatalog): Promise<SkillSyncContext> {
  const existing = await catalog.listSkills();
  const pendingDeletes = new Set(
    existing.filter((row) => row.pendingDelete !== null).map((row) => row.name),
  );
  return { existing, pendingDeletes };
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
  catalog: SkillCatalog,
  input: SkillCatalogSyncInput,
  context: SkillSyncContext,
): Promise<string | null> {
  if (context.pendingDeletes.has(input.name)) return null;
  const existing = context.existing.find((row) => row.name === input.name);
  const row = await catalog.putSkill(input);
  if (existing?.id === row.id) return row.id;
  const raced =
    // An existence test that reads the record whole: `head` bypasses the meta-column view, so it
    // would miss a record held only in the column.
    (await readWhole(store, skillMetaKey(input.name))) === null ||
    (await pendingSkillDelete(catalog, input.name)) !== null;
  if (!raced) return row.id;
  await catalog.deleteSkill(input.name);
  return null;
}
