import { randomUUID } from 'node:crypto';

import {
  clampListLimit,
  type ListPageOptions,
  type ObjectListEntry,
  type ObjectPage,
} from './object-store.js';
import { cursorAfter, listedEntries } from './streams.js';

import {
  paused,
  PAUSED_WALK_IDLE_MS,
  PAUSED_WALKS_MAX,
  type PausedWalk,
} from './folder-store-state.js';

export function createFolderPager(
  listing: Parameters<typeof listedEntries>[0],
  prefixOf: (prefix: string) => string,
) {
  /** This store's key in the paused table: a cursor resumes only a walk this store paused. */
  const storeId = randomUUID();
  const pausedId = (prefix: string, recursive: boolean, cursor: string): string =>
    JSON.stringify([storeId, recursive, prefix, cursor]);

  /** Ends a paused listing: its open folders are closed, and its skips reported. */
  function closePaused(walk: PausedWalk): void {
    clearTimeout(walk.timer);
    walk.entries.return(undefined).catch((error: unknown) => {
      process.emitWarning('A paused folder listing could not close its folders.', {
        code: 'AW_FOLDER_STORE_CLOSE',
        detail: error instanceof Error ? error.name : 'unknown',
      });
    });
  }

  function pause(id: string, entries: AsyncGenerator<ObjectListEntry>, next: ObjectListEntry) {
    const held = paused.get(id);
    if (held !== undefined) closePaused(held);
    paused.delete(id);
    const [oldest] = paused;
    if (paused.size >= PAUSED_WALKS_MAX && oldest !== undefined) {
      paused.delete(oldest[0]);
      closePaused(oldest[1]);
    }
    const walk: PausedWalk = {
      entries,
      next,
      timer: setTimeout(() => {
        if (paused.get(id) !== walk) return;
        paused.delete(id);
        closePaused(walk);
      }, PAUSED_WALK_IDLE_MS).unref(),
    };
    paused.set(id, walk);
  }

  /**
   * One page of a listing. A page that fills pauses its walk, open folders and all, and the page
   * that passes its cursor back carries on from there: one walk reads each folder once and reports
   * its skips once, however many pages it takes. A cursor with no paused walk (another store's, an
   * idle one's) starts a new walk that skips to it.
   */
  async function listFolderPage(
    prefix: string,
    pageOptions: ListPageOptions | undefined,
  ): Promise<ObjectPage> {
    pageOptions?.signal?.throwIfAborted();
    const limit = clampListLimit(pageOptions?.limit);
    const recursive = pageOptions?.recursive === true;
    const safe = prefixOf(prefix);
    const cursor = pageOptions?.cursor;
    const resumed =
      cursor === undefined ? undefined : paused.get(pausedId(safe, recursive, cursor));
    if (resumed !== undefined && cursor !== undefined) {
      paused.delete(pausedId(safe, recursive, cursor));
      clearTimeout(resumed.timer);
    }
    const entries = resumed?.entries ?? listedEntries(listing, prefix, pageOptions);
    const page: ObjectListEntry[] = [];
    let next = resumed?.next;
    for (;;) {
      if (next === undefined) {
        const pulled = await entries.next();
        if (pulled.done === true) return { entries: page, cursor: null };
        next = pulled.value;
      }
      const last = page[page.length - 1];
      if (page.length === limit && last !== undefined) {
        const after = cursorAfter(last);
        pause(pausedId(safe, recursive, after), entries, next);
        return { entries: page, cursor: after };
      }
      page.push(next);
      next = undefined;
    }
  }

  return listFolderPage;
}
