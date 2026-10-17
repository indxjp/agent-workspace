/**
 * The pending-delete marker of `DELETE /api/skills/:name`, and the catalog sync that respects it
 * (issue #240 review, ADR-0077 D3).
 *
 * `GET /api/skills` and `GET /api/skills/:name` upsert a catalog row for every skill whose
 * `skill-meta/<name>.json` they find. A delete removes the catalog row before the bytes, so without
 * a marker that sync would re-create the row between the two steps — owned by whoever listed, or as
 * a row with no bytes once the delete finishes. The marker (`skill-deletes/<name>.json`) is written
 * before the row goes and removed last. While it exists the sync never inserts a row, and it
 * records the owner, so the owning Builder can finish an interrupted delete.
 */
import type { CatalogSkill, ResourceCatalogRepository } from '@agent-workspace/core/db';

import { SKILL_DELETE_PREFIX, skillDeleteMarkerKey, skillMetaKey } from './keys';
import type { ObjectStore } from './object-store-bridge';

/** What a pending delete recorded: the owner of the row it removed, when it had one. */
export interface PendingSkillDelete {
  readonly ownerPrincipalId: string | null;
}

/** The marker for `name`, or `null` when no delete of it is pending. */
export async function readPendingSkillDelete(
  store: ObjectStore,
  name: string,
): Promise<PendingSkillDelete | null> {
  const object = await store.get(skillDeleteMarkerKey(name));
  if (object === null) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(object.body).toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'ownerPrincipalId' in parsed) {
      const owner = parsed.ownerPrincipalId;
      if (typeof owner === 'string') return { ownerPrincipalId: owner };
    }
  } catch {
    // An unreadable marker still marks the delete as pending; it just proves no owner.
  }
  return { ownerPrincipalId: null };
}

/** Record that a delete of `name` is under way, and whose skill it was. */
export async function writePendingSkillDelete(
  store: ObjectStore,
  name: string,
  pending: PendingSkillDelete,
): Promise<void> {
  await store.put(skillDeleteMarkerKey(name), {
    body: Buffer.from(JSON.stringify(pending), 'utf8'),
    contentType: 'application/json',
  });
}

/** Remove the marker: the delete finished, or was refused before it changed anything. */
export async function clearPendingSkillDelete(store: ObjectStore, name: string): Promise<void> {
  await store.delete(skillDeleteMarkerKey(name));
}

/** The names of every skill with a delete pending in this workspace. */
export async function pendingSkillDeleteNames(store: ObjectStore): Promise<ReadonlySet<string>> {
  const prefix = `${SKILL_DELETE_PREFIX}/`;
  const suffix = '.json';
  const names = new Set<string>();
  for (const entry of await store.list(SKILL_DELETE_PREFIX)) {
    if (entry.kind !== 'file' || !entry.key.startsWith(prefix) || !entry.key.endsWith(suffix)) {
      continue;
    }
    names.add(entry.key.slice(prefix.length, entry.key.length - suffix.length));
  }
  return names;
}

/** What a read route would write to the catalog for one listed skill. */
export type SkillCatalogSyncInput = Parameters<ResourceCatalogRepository['putSkill']>[0];

/**
 * Upsert the catalog row a read route found bytes for, unless a delete is pending, and return its
 * id — or `null` when the skill is being deleted and has no row left to answer with.
 *
 * - A pending delete never gets a row inserted: an existing row still answers with its id (the
 *   delete may yet be refused as in use), and a missing one leaves the skill out.
 * - A row this call inserted is checked once more. If the skill's platform record is gone or a
 *   delete started meanwhile, the sync raced a delete, so the row it inserted is removed again.
 *   Together with the delete's own final sweep, no sync leaves a row behind a delete.
 */
export async function syncSkillCatalogRow(
  store: ObjectStore,
  catalog: ResourceCatalogRepository,
  input: SkillCatalogSyncInput,
  context: {
    readonly existing: readonly CatalogSkill[];
    readonly pendingDeletes: ReadonlySet<string>;
  },
): Promise<string | null> {
  const existing = context.existing.find((row) => row.name === input.name);
  if (context.pendingDeletes.has(input.name)) return existing?.id ?? null;
  const row = await catalog.putSkill(input);
  if (existing?.id === row.id) return row.id;
  const raced =
    (await store.get(skillMetaKey(input.name))) === null ||
    (await readPendingSkillDelete(store, input.name)) !== null;
  if (!raced) return row.id;
  await catalog.deleteSkill(input.name);
  return null;
}
