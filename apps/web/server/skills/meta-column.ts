/**
 * Where a skill's platform record (`{ name, enabled, createdAt, updatedAt }`) lives: the `meta`
 * column of its catalog row, never an object under `skill-meta/` (the storage design, §07 "Rules CI
 * enforces").
 *
 * The skills handlers read and write that record through the object-store port at
 * `skill-meta/<name>.json` (`read`, `write` and a one-level `listPage`). {@link withSkillMetaColumn} answers those keys from the catalog and
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
import {
  bytesToStream,
  listAll,
  listPageFrom,
  readWhole,
  streamToBytes,
} from '@agent-workspace/core/storage/streams';
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

type SkillObjectStream = NonNullable<Awaited<ReturnType<SkillObjects['read']>>>;

/** The record as a read answers it: the whole body, unranged, with no stored version. */
function recordStream(
  bytes: Uint8Array,
  contentType: string | null,
  lastModified: Date,
): SkillObjectStream {
  const meta = { sizeBytes: bytes.byteLength, contentType, etag: '', lastModified };
  return { meta, body: bytesToStream(bytes), range: null };
}

export function withSkillMetaColumn(store: SkillObjects, catalog: MetaCatalog): SkillObjects {
  if (views.has(store)) return store;
  // The listing of each walk still in progress, keyed by the cursor its next page passes back. A
  // view lives for one request, so an abandoned walk is dropped with it.
  const walks = new Map<string, readonly SkillObjectEntry[]>();
  // The records held only in a column are paged with the legacy objects as one listing.
  const mergedListing = async (prefix: string): Promise<readonly SkillObjectEntry[]> => {
    const listed = await listAll(store, prefix);
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
  };
  const view: SkillObjects = {
    ...store,
    async read(key, options) {
      const name = skillNameFromMetaKey(key);
      if (name === null) return store.read(key, options);
      // One by-name read, so a list that reads every record stays linear in the skills.
      const row = await catalog.getSkill(name);
      if (row?.meta !== null && row?.meta !== undefined) {
        const body = new TextEncoder().encode(JSON.stringify(row.meta));
        return recordStream(body, JSON_TYPE, new Date());
      }
      // storage-bridge(#1699): read skill marker objects written before the columns existed
      const legacy = await readWhole(store, key);
      if (legacy === null) return null;
      const record = parseRecord(legacy.body);
      if (row !== null && record !== null) await catalog.setSkillMeta(name, record, true);
      return recordStream(legacy.body, legacy.contentType, legacy.lastModified);
    },
    async write(key, body, options) {
      const name = skillNameFromMetaKey(key);
      if (name === null) return store.write(key, body, options);
      const bytes = body instanceof Uint8Array ? body : await streamToBytes(body);
      const record = parseRecord(bytes);
      if (record === null) throw new Error(`skill ${name} record is not a JSON value`);
      if (await catalog.setSkillMeta(name, record)) {
        return recordStream(bytes, options.contentType ?? null, new Date()).meta;
      }
      // storage-bridge(#1699): a skill that only has its legacy record and no row yet keeps being
      // rewritten there until the next list or read gives it a row
      if ((await store.head(key)) !== null) return store.write(key, bytes, options);
      throw new Error(`skill ${name} has no catalog row to hold its record`);
    },
    async delete(key) {
      const name = skillNameFromMetaKey(key);
      if (name !== null) await catalog.setSkillMeta(name, null);
      await store.delete(key);
    },
    async listPage(prefix, options) {
      if (prefix !== SKILL_META_PREFIX || options?.recursive === true) {
        return store.listPage(prefix, options);
      }
      // A walk builds its listing on its first page and pages the rest from it, so a walk reads the
      // catalog and the legacy objects once rather than once per page.
      const resumed = options?.cursor === undefined ? undefined : walks.get(options.cursor);
      if (options?.cursor !== undefined) walks.delete(options.cursor);
      const entries = resumed ?? (await mergedListing(prefix));
      const merged = (): Promise<readonly SkillObjectEntry[]> => Promise.resolve(entries);
      const page = await listPageFrom({ level: merged, tree: merged }, prefix, options);
      if (page.cursor !== null) walks.set(page.cursor, entries);
      return page;
    },
  };
  views.add(view);
  return view;
}
