/**
 * Where a skill's platform record (`{ name, enabled, createdAt, updatedAt }`) lives: the `meta`
 * column of its catalog row, never an object under `skill-meta/` (the storage design, §07 "Rules CI
 * enforces").
 *
 * The skills handlers read and write that record through the object-store port at
 * `skill-meta/<name>.json`. {@link withSkillMetaColumn} answers those keys from the catalog and
 * passes every other key through, so the handlers stay as they are and nothing is written under
 * the prefix.
 *
 * - Reads and lists use the column. A row whose column is empty falls back to the record an earlier
 *   release wrote as an object, and the column is filled from it.
 * - Writes go to the column only.
 * - Deleting the record clears the column and removes the legacy object too: the skill is gone, and
 *   a leftover object would bring it back. Removing the legacy objects of skills that are not
 *   being deleted is the finalize step's job (#1676).
 */
import type { SkillObjectEntry, SkillObjects } from '../storage/store';

import { skillMetaKey, skillNameFromMetaKey, SKILL_META_PREFIX } from './keys';

/** The catalog calls this view needs; the resource catalog satisfies it structurally. */
interface MetaCatalog {
  listSkills(): Promise<readonly { readonly name: string; readonly meta: unknown }[]>;
  getSkill(name: string): Promise<{ readonly meta: unknown } | null>;
  setSkillMeta(name: string, meta: unknown, onlyIfEmpty?: boolean): Promise<boolean>;
}

const views = new WeakSet<SkillObjects>();

const JSON_TYPE = 'application/json';

function parseRecord(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8').decode(bytes));
  } catch {
    return null;
  }
}

export function withSkillMetaColumn(store: SkillObjects, catalog: MetaCatalog): SkillObjects {
  if (views.has(store)) return store;
  const view: SkillObjects = {
    ...store,
    async get(key) {
      const name = skillNameFromMetaKey(key);
      if (name === null) return store.get(key);
      // One by-name read, so a list that reads every record stays linear in the skills.
      const row = await catalog.getSkill(name);
      if (row?.meta !== null && row?.meta !== undefined) {
        const body = new TextEncoder().encode(JSON.stringify(row.meta));
        return {
          body,
          contentType: JSON_TYPE,
          sizeBytes: body.byteLength,
          lastModified: new Date(),
        };
      }
      // storage-bridge(#1699): read skill marker objects written before the columns existed
      const legacy = await store.get(key);
      if (legacy === null) return null;
      const record = parseRecord(legacy.body);
      if (row !== null && record !== null) await catalog.setSkillMeta(name, record, true);
      return legacy;
    },
    async put(key, input) {
      const name = skillNameFromMetaKey(key);
      if (name === null) return store.put(key, input);
      const record = parseRecord(input.body);
      if (record === null) throw new Error(`skill ${name} record is not a JSON value`);
      if (await catalog.setSkillMeta(name, record)) return;
      // storage-bridge(#1699): a skill that only has its legacy record and no row yet keeps being
      // rewritten there until the next list or read gives it a row
      if ((await store.get(key)) !== null) return store.put(key, input);
      throw new Error(`skill ${name} has no catalog row to hold its record`);
    },
    async delete(key) {
      const name = skillNameFromMetaKey(key);
      if (name !== null) await catalog.setSkillMeta(name, null);
      await store.delete(key);
    },
    async list(prefix) {
      const listed = await store.list(prefix);
      if (prefix !== SKILL_META_PREFIX) return listed;
      const seen = new Set(listed.map((entry) => entry.key));
      const fromRows: SkillObjectEntry[] = [];
      for (const row of await catalog.listSkills()) {
        const key = skillMetaKey(row.name);
        if (row.meta === null || seen.has(key)) continue;
        fromRows.push({
          kind: 'file',
          key,
          sizeBytes: JSON.stringify(row.meta).length,
          contentType: JSON_TYPE,
          lastModified: new Date(),
        });
      }
      return [...listed, ...fromRows];
    },
  };
  views.add(view);
  return view;
}
