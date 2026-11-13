import type { SessionStateStore } from './state';
import type { TranscriptEntry } from './transcript';

/**
 * The whole of one stream, read page by page, or `null` when the stream was never written.
 *
 * Followed until a page comes back empty, because the repository caps a page and a short page is a
 * fact about that cap, not about the end of the stream. Shared by the transcript route
 * (`./api.ts`) and the home chat's earlier messages (`./history.ts`).
 */
export async function readWholeStream(
  store: SessionStateStore,
  ref: Parameters<SessionStateStore['list']>[0],
): Promise<TranscriptEntry[] | null> {
  const collected: TranscriptEntry[] = [];
  let afterSequence: number | undefined;
  for (;;) {
    const page = await store.list(ref, { afterSequence });
    if (page === null) return collected.length === 0 ? null : collected;
    const last = page.at(-1);
    if (last === undefined) return collected;
    // The store holds what the runner's Claude adapter appended, which is the Agent SDK's
    // `SessionStoreEntry` verbatim; the store reads no field of it.
    for (const one of page) collected.push(one.entry as TranscriptEntry);
    afterSequence = last.sequence;
  }
}
