import { ContractViolationError } from './errors.js';

/** What one page request yields to {@link walkPages}. */
interface WalkedPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
}

/**
 * Yield every item of a cursor-paged list, requesting the next page only when the caller has
 * consumed the previous one. Starts at `firstCursor` (or the newest page) and stops after the page
 * whose `nextCursor` is `null`.
 *
 * A server that hands back a cursor this walk has already sent would make it loop forever; that
 * is refused as a {@link ContractViolationError} instead, because the contract promises every
 * `nextCursor` moves strictly past the page it ends.
 */
export async function* walkPages<Item>(
  operation: string,
  firstCursor: string | undefined,
  fetchPage: (cursor: string | undefined) => Promise<WalkedPage<Item>>,
): AsyncGenerator<Item, void, undefined> {
  const sent = new Set<string>();
  let cursor = firstCursor;
  for (;;) {
    if (cursor !== undefined) sent.add(cursor);
    const page = await fetchPage(cursor);
    yield* page.items;
    if (page.nextCursor === null) return;
    if (sent.has(page.nextCursor)) {
      throw new ContractViolationError({
        operation,
        status: 200,
        issues: ['nextCursor repeats a cursor this walk already sent'],
      });
    }
    cursor = page.nextCursor;
  }
}
