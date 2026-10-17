/**
 * Walk an {@link ObjectStore} prefix down to every file beneath it, recursively.
 *
 * `ObjectStore.list(prefix)` is deliberately one level, not recursive — `object-store.ts`'s header
 * says so, "matching `ListObjectsV2`'s `Delimiter: '/'` behaviour", and "a caller that wants a whole
 * tree calls this once per folder it discovers, the same way the S3 API itself is walked." A skill
 * directory can nest supporting files arbitrarily deep (spec §7's own tree shows only one level,
 * but does not forbid more), and this task's export must reproduce every one of them, so this is
 * that caller.
 */
import type { ObjectStore } from './object-store-bridge';

/** One file found under a walked prefix, with its key relative to the prefix that was walked. */
export interface WalkedFile {
  /** The file's full store key, e.g. `skills/demo/scripts/run.sh`. */
  readonly key: string;
  /** The same file's path relative to the walked prefix, e.g. `scripts/run.sh`. */
  readonly relativePath: string;
  /**
   * The file's size, as `ObjectStore.list` already reported it. Carried here so a caller that
   * only needs sizes — `describeSkill`, listing a whole workspace's skills — does not have to
   * `get` every file's bytes back just to measure them.
   */
  readonly sizeBytes: number;
}

/**
 * Every file at or under `prefix`, in a stable order (lexicographic on `relativePath`) so two
 * callers of this function on the same tree always see files in the same sequence — the round-trip
 * proof this task ships hashes files pairwise by that order.
 */
export async function walkFiles(store: ObjectStore, prefix: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];

  async function recurse(at: string): Promise<void> {
    const entries = await store.list(at);
    for (const entry of entries) {
      if (entry.kind === 'folder') {
        await recurse(entry.key);
      } else {
        out.push({
          key: entry.key,
          relativePath: entry.key.slice(prefix.length + 1),
          sizeBytes: entry.sizeBytes,
        });
      }
    }
  }

  await recurse(prefix);
  out.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  return out;
}
