/**
 * `FileTranscriptStore` — a {@link TranscriptStore} that survives the death of the process that
 * wrote it.
 *
 * ## Why this backend exists, and what it is not
 *
 * Spec §20 says *"Implement a TypeScript `SessionStore` backed by durable storage. Prefer using
 * PostgreSQL"*, and R-01 §7 points at the vendor's Postgres reference adapter as the shape to
 * copy. **This is not that adapter, and it does not pretend to be.**
 *
 * A PostgreSQL adapter needs a table, a repository and a line on the repository barrel, and all
 * three live in files this task does not own: `packages/core/src/db/schema/**` is W2-DB-01's,
 * `packages/core/src/db/repositories/**` is W2-DB-02's, and `packages/core/src/db/index.ts` is a
 * deliberately narrow barrel this task was told by name not to widen — sub-wave 2a closed two
 * live tenant-isolation bypasses caused by what it used to re-export. `apps/web` cannot reach
 * PostgreSQL any other way: `openDatabaseRoot()` returns scope-bound repositories and no
 * queryable handle, which is the whole point of it, and `@agent-workspace/core/db/unscoped`
 * refuses to load outside a test runner.
 *
 * So the durable backend that could be **written and shipped inside this task's ownership** is
 * this one, the store is reached through the {@link TranscriptStore} port, and the PostgreSQL
 * adapter is a declared gap with its exact table, repository interface and barrel lines written
 * out in `docs/adr/W2-CP-07-session-state-has-no-table-in-section-27.md`. Swapping it in changes one line
 * in a composition root and nothing else — which is what the port is for.
 *
 * What this backend does close is the thing §14.9 calls the release blocker: session state no
 * longer lives *inside the sandbox*. It lives in the control plane, on storage the control plane
 * owns, and a sandbox that is destroyed takes nothing with it.
 *
 * ## What "durable" means here, exactly
 *
 * One file per key, JSON Lines, replaced atomically:
 *
 * ```text
 *   <root>/<projectKey>/<sessionId>/main.jsonl               the main transcript
 *   <root>/<projectKey>/<sessionId>/sub-<hex>.jsonl          one subagent transcript
 * ```
 *
 * `<hex>` is the `subpath` hex-encoded. That is reversible, which is what lets `listSubkeys()`
 * answer from the directory listing alone, and it is the reason no `subpath` — however it was
 * spelled — can name a path outside its own session directory. The key is still parsed first
 * (`transcript.ts`): encoding is not a substitute for refusing a key, it is what makes the
 * refusal unnecessary to trust.
 *
 * A write is `writeFile` to a unique temporary name in the same directory followed by `rename`,
 * which is atomic on both platforms this repository is built on. A reader therefore sees either
 * the batch before or the batch after, never half of one, and a process killed mid-write leaves
 * a stray temporary file rather than a truncated transcript.
 *
 * **It is a single-node store.** Two control-plane replicas sharing one directory are ordered by
 * the filesystem and the per-key serialiser does not span processes. That is the same bound
 * `migrations run inside the web container's entrypoint` already has, it is stated rather than
 * discovered, and it is the second reason the PostgreSQL adapter is the one a cluster wants.
 *
 * **It writes O(N²) bytes per session, and nothing bounds N.** {@link FileTranscriptStore.append}
 * is a read–merge–rewrite, because the upsert-on-`uuid` rule applies to the whole transcript; the
 * bytes one session costs are therefore the sum of its sizes after every batch, which is the final
 * size times (batches + 1) / 2. Measured on this branch: 300 single-entry appends producing a
 * 150 790-byte transcript wrote 22 682 445 bytes, an amplification of 150.4×, in 745 ms on one
 * Windows host. The acceptance run's own session is nine entries and two batches, so nothing in
 * this task's evidence is near a size where it hurts — which is exactly why it is written down
 * here rather than left to be met in production. The PostgreSQL adapter, whose `insert … on
 * conflict` writes one row per entry, does not have this shape.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  KeyedSerialiser,
  mergeTranscriptEntries,
  parseTranscriptEntry,
  transcriptKeyId,
  type TranscriptEntry,
  type TranscriptKey,
  type TranscriptSessionListing,
  type TranscriptStore,
} from './transcript';

/** The filename a main transcript takes. `sub-` prefixes everything else, so no collision. */
const MAIN_TRANSCRIPT_FILE = 'main.jsonl';
const SUBKEY_PREFIX = 'sub-';
const TRANSCRIPT_SUFFIX = '.jsonl';

/**
 * A `projectKey` and a `sessionId` are already constrained to `[A-Za-z0-9_-]` and to the UUID
 * grammar by `transcript.ts`, so both are safe directory names — but this store does not take
 * that on trust from a caller that may have skipped the parse. It hashes nothing and escapes
 * nothing; it **refuses**, because a store that silently repaired a bad key would be storing one
 * tenant's transcript under another tenant's directory.
 */
const SAFE_DIRECTORY_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

function assertSafeSegment(kind: string, value: string): void {
  if (!SAFE_DIRECTORY_SEGMENT.test(value)) {
    throw new Error(
      `refusing to build a storage path from ${kind} ${JSON.stringify(value)}: it is not a single ` +
        `[A-Za-z0-9_-]{1,64} segment. Parse the key with parseTranscriptKey() before storing it.`,
    );
  }
}

/** Hex, so the encoding is reversible and `listSubkeys()` can read the directory back. */
function encodeSubpath(subpath: string): string {
  return Buffer.from(subpath, 'utf8').toString('hex');
}

function decodeSubpath(hex: string): string | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
  return Buffer.from(hex, 'hex').toString('utf8');
}

export class FileTranscriptStore implements TranscriptStore {
  readonly #root: string;
  readonly #serialiser = new KeyedSerialiser();

  constructor(root: string) {
    if (root.trim().length === 0) {
      throw new Error('FileTranscriptStore needs a root directory; got an empty string.');
    }
    this.#root = path.resolve(root);
  }

  /** The directory holding one session's transcripts, main and subagent alike. */
  #sessionDirectory(projectKey: string, sessionId: string): string {
    assertSafeSegment('projectKey', projectKey);
    assertSafeSegment('sessionId', sessionId);
    return path.join(this.#root, projectKey, sessionId);
  }

  #fileFor(key: TranscriptKey): string {
    const directory = this.#sessionDirectory(key.projectKey, key.sessionId);
    if (key.subpath === undefined) return path.join(directory, MAIN_TRANSCRIPT_FILE);
    return path.join(
      directory,
      `${SUBKEY_PREFIX}${encodeSubpath(key.subpath)}${TRANSCRIPT_SUFFIX}`,
    );
  }

  /**
   * Read one transcript file, or `null` when it is not there.
   *
   * A line that does not parse is a **hard failure naming the file and the line**, never a
   * dropped entry: `load()` is what a resume is built from, and a transcript silently missing a
   * line is a conversation that silently lost a turn (ADR-0015).
   */
  async #read(file: string): Promise<TranscriptEntry[] | null> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const entries: TranscriptEntry[] = [];
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `${file}:${String(index + 1)} is not JSON, so this transcript cannot be loaded: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const entry = parseTranscriptEntry(raw);
      if (!entry.ok) {
        throw new Error(`${file}:${String(index + 1)} is not a transcript entry: ${entry.reason}`);
      }
      entries.push(entry.value);
    }
    return entries;
  }

  /** Replace a transcript file atomically: unique temporary name, then `rename` over the target. */
  async #write(file: string, entries: readonly TranscriptEntry[]): Promise<void> {
    const directory = path.dirname(file);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
    const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
    await writeFile(temporary, entries.length === 0 ? '' : `${body}\n`, 'utf8');
    await rename(temporary, file);
  }

  /**
   * `async` for the same reason {@link FileTranscriptStore.load} is — see the note there. It was
   * not, and `#fileFor()` ran *outside* the returned promise, so an unparsed key left this method
   * as a synchronous `throw`: `store.append(key, batch).catch(…)` never saw it, and a `try`
   * written around the `await` was the only thing that could. That is the fail-open shape
   * ADR-0015 names, at the type level rather than in a branch, and
   * `store.test.ts` now drives **every** member of the port with an unparsed key rather than
   * `load()` alone.
   *
   * ## Write amplification
   *
   * This is a read–merge–rewrite: the upsert-on-`uuid` rule of {@link TranscriptStore.append}
   * is applied over the whole transcript and the whole transcript is written back. One session
   * therefore costs O(N²) bytes on disk over its life, where N is its final size, and nothing
   * bounds N. It is measured and declared on this task's PR rather than left to be discovered.
   */
  async append(key: TranscriptKey, entries: readonly TranscriptEntry[]): Promise<void> {
    const file = this.#fileFor(key);
    return this.#serialiser.run(transcriptKeyId(key), async () => {
      const existing = await this.#read(file);
      await this.#write(file, mergeTranscriptEntries(existing ?? [], entries));
    });
  }

  /**
   * `async`, so that a key this store refuses to build a path from comes back as a **rejected
   * promise** rather than as a synchronous throw. A caller that wrote `store.load(key).catch(…)`
   * would otherwise miss the refusal entirely, which is the fail-open shape of a check that
   * cannot be observed.
   */
  async load(key: TranscriptKey): Promise<TranscriptEntry[] | null> {
    return this.#read(this.#fileFor(key));
  }

  async listSessions(projectKey: string): Promise<TranscriptSessionListing[]> {
    assertSafeSegment('projectKey', projectKey);
    const directory = path.join(this.#root, projectKey);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const listing: TranscriptSessionListing[] = [];
    for (const name of names) {
      // A session is a directory holding a main transcript. A directory with no main transcript
      // holds only subagent files and is not a session anyone can resume, so it is not listed.
      const main = path.join(directory, name, MAIN_TRANSCRIPT_FILE);
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(main)).mtimeMs;
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      listing.push({ sessionId: name, mtime: Math.trunc(mtimeMs) });
    }
    listing.sort(
      (left, right) => right.mtime - left.mtime || left.sessionId.localeCompare(right.sessionId),
    );
    return listing;
  }

  /** `async` for the reason {@link FileTranscriptStore.load} gives; every member here is. */
  async delete(key: TranscriptKey): Promise<void> {
    return this.#serialiser.run(transcriptKeyId(key), async () => {
      if (key.subpath === undefined) {
        // R-01 §7: deleting a main key cascades to every subkey. The session directory holds
        // exactly the main transcript and its subagents, so removing it is that cascade.
        await rm(this.#sessionDirectory(key.projectKey, key.sessionId), {
          recursive: true,
          force: true,
        });
        return;
      }
      await rm(this.#fileFor(key), { force: true });
    });
  }

  async listSubkeys(key: {
    readonly projectKey: string;
    readonly sessionId: string;
  }): Promise<string[]> {
    const directory = this.#sessionDirectory(key.projectKey, key.sessionId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const subpaths: string[] = [];
    for (const name of names) {
      if (!name.startsWith(SUBKEY_PREFIX) || !name.endsWith(TRANSCRIPT_SUFFIX)) continue;
      const hex = name.slice(SUBKEY_PREFIX.length, name.length - TRANSCRIPT_SUFFIX.length);
      const subpath = decodeSubpath(hex);
      // An undecodable name is refused rather than skipped: this store wrote every file in here,
      // so one it cannot read back is corruption, and reporting fewer subkeys than exist would
      // silently drop a subagent transcript from a resume (ADR-0031).
      if (subpath === null) {
        throw new Error(
          `${path.join(directory, name)} is not a name this store writes: the segment after ` +
            `'${SUBKEY_PREFIX}' is not hex, so its subpath cannot be recovered.`,
        );
      }
      subpaths.push(subpath);
    }
    subpaths.sort();
    return subpaths;
  }

  /** The directory this store writes under. Printed by a composition root at start-up. */
  get root(): string {
    return this.#root;
  }

  /** A short, stable fingerprint of the root, for a log line that must not print a full path. */
  get fingerprint(): string {
    return createHash('sha256').update(this.#root).digest('hex').slice(0, 12);
  }
}

/** Was this an `ENOENT`? Read off the error rather than assumed from the operation failing. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}
