/**
 * An in-memory {@link SessionStateStore}, for suites that are about the *routes* rather than about
 * PostgreSQL (ENG-06, #305).
 *
 * It exists for the same reason `./memory-store.ts` does: a route test that had to start a database
 * would be a route test nobody runs while iterating, and the handler's behaviour — the parse, the
 * scoping, the engine check, the 404 concealment — is the same over either backend.
 *
 * The rules it implements are the store's rules and not a simplification of them, because a fake
 * that agreed with the real store only on the easy cases would make the route suite say nothing
 * about the hard ones:
 *
 *   * `append` upserts **in place** on `entryKey` and appends a keyless entry;
 *   * `sequence` is dense from 1, and `replaceAll` renumbers from 1;
 *   * `list` answers `null` for a stream that was never written and `[]` for an empty one, and
 *     caps a page at `SESSION_STATE_PAGE_LIMIT` whatever limit is asked for;
 *   * a blob is refused over the cap by the *route*, so this store simply keeps what it is given.
 *
 * `apps/web/server/sessions/state-store.test.ts` runs one contract suite against this and against
 * the PostgreSQL store, which is what keeps the two from drifting.
 */
import { createHash } from 'node:crypto';

import type { EngineId } from '@indx-workspace/contracts/engines';
import { SESSION_STATE_PAGE_LIMIT } from '@agent-workspace/core/db';

import type {
  SessionStateBlobContent,
  SessionStateBlobRef,
  SessionStateEntryPayload,
  SessionStateEntryRecord,
  SessionStateStore,
  SessionStateStreamRecord,
  SessionStateStreamRef,
} from './state';

interface Stream {
  readonly engine: EngineId;
  readonly streamKey: string;
  entries: SessionStateEntryRecord[];
  updatedAt: number;
}

/**
 * A stable string for one stream.
 *
 * `JSON.stringify` of the four fields rather than a joined string with a separator: a separator has
 * to be a character no field can contain, and `streamKey` is adapter-defined printable ASCII, so
 * there is none to pick. The array encoding cannot be made ambiguous by a field's contents.
 */
function streamId(ref: SessionStateStreamRef): string {
  return JSON.stringify([ref.workspaceId, ref.sessionId, ref.engine, ref.streamKey]);
}

function blobId(ref: SessionStateBlobRef): string {
  return JSON.stringify([ref.workspaceId, ref.sessionId, ref.engine, ref.blobKey]);
}

export class InMemorySessionStateStore implements SessionStateStore {
  readonly #streams = new Map<string, Stream>();
  readonly #blobs = new Map<string, SessionStateBlobContent>();
  /** Absent means this fake has no blob backend, the way a deployment with no object store has none. */
  readonly #blobsEnabled: boolean;
  #clock = 0;

  public constructor(options: { readonly blobs?: boolean } = {}) {
    this.#blobsEnabled = options.blobs ?? true;
  }

  #touch(ref: SessionStateStreamRef): Stream {
    const id = streamId(ref);
    this.#clock += 1;
    const existing = this.#streams.get(id);
    if (existing !== undefined) {
      existing.updatedAt = this.#clock;
      return existing;
    }
    const created: Stream = {
      engine: ref.engine,
      streamKey: ref.streamKey,
      entries: [],
      updatedAt: this.#clock,
    };
    this.#streams.set(id, created);
    return created;
  }

  append(ref: SessionStateStreamRef, entries: readonly SessionStateEntryPayload[]): Promise<void> {
    const stream = this.#touch(ref);
    for (const incoming of entries) {
      const key = incoming.entryKey;
      const at =
        key === undefined ? -1 : stream.entries.findIndex((entry) => entry.entryKey === key);
      if (at >= 0) {
        const previous = stream.entries[at];
        if (previous !== undefined) {
          stream.entries[at] = { ...previous, entry: incoming.entry };
        }
        continue;
      }
      stream.entries.push({
        sequence: stream.entries.length + 1,
        entryKey: key ?? null,
        entry: incoming.entry,
      });
    }
    return Promise.resolve();
  }

  list(
    ref: SessionStateStreamRef,
    page: { readonly afterSequence?: number | undefined; readonly limit?: number | undefined },
  ): Promise<readonly SessionStateEntryRecord[] | null> {
    const stream = this.#streams.get(streamId(ref));
    if (stream === undefined) return Promise.resolve(null);
    const after = page.afterSequence ?? 0;
    const matching = stream.entries.filter((entry) => entry.sequence > after);
    // The repository's default and ceiling, so a route that reads a long stream page by page is
    // exercised past its first page here too.
    const limit = Math.min(page.limit ?? SESSION_STATE_PAGE_LIMIT, SESSION_STATE_PAGE_LIMIT);
    return Promise.resolve(matching.slice(0, limit));
  }

  deleteLast(ref: SessionStateStreamRef): Promise<number> {
    const stream = this.#streams.get(streamId(ref));
    if (stream === undefined || stream.entries.length === 0) return Promise.resolve(0);
    stream.entries.pop();
    return Promise.resolve(1);
  }

  replaceAll(
    ref: SessionStateStreamRef,
    entries: readonly SessionStateEntryPayload[],
  ): Promise<void> {
    const stream = this.#touch(ref);
    stream.entries = entries.map((incoming, index) => ({
      sequence: index + 1,
      entryKey: incoming.entryKey ?? null,
      entry: incoming.entry,
    }));
    return Promise.resolve();
  }

  deleteStream(ref: SessionStateStreamRef): Promise<void> {
    this.#streams.delete(streamId(ref));
    return Promise.resolve();
  }

  listStreams(tenant: {
    readonly workspaceId: string;
    readonly sessionId: string;
  }): Promise<readonly SessionStateStreamRecord[]> {
    const prefix = JSON.stringify([tenant.workspaceId, tenant.sessionId]).slice(0, -1);
    const rows: SessionStateStreamRecord[] = [];
    for (const [id, stream] of this.#streams) {
      if (!id.startsWith(`${prefix},`)) continue;
      rows.push({
        engine: stream.engine,
        streamKey: stream.streamKey,
        updatedAt: stream.updatedAt,
      });
    }
    return Promise.resolve(
      rows.sort((a, b) => b.updatedAt - a.updatedAt || a.streamKey.localeCompare(b.streamKey)),
    );
  }

  putBlob(
    ref: SessionStateBlobRef,
    bytes: Uint8Array,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
    if (!this.#blobsEnabled) {
      return Promise.resolve({ ok: false, reason: 'this fake store has no blob backend.' });
    }
    this.#blobs.set(blobId(ref), {
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    return Promise.resolve({ ok: true });
  }

  getBlob(
    ref: SessionStateBlobRef,
  ): Promise<
    | { readonly ok: true; readonly content: SessionStateBlobContent | null }
    | { readonly ok: false; readonly reason: string }
  > {
    if (!this.#blobsEnabled) {
      return Promise.resolve({ ok: false, reason: 'this fake store has no blob backend.' });
    }
    return Promise.resolve({ ok: true, content: this.#blobs.get(blobId(ref)) ?? null });
  }
}
