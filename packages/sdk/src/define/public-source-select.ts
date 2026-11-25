import {
  PUBLIC_SOURCE_LIMITS,
  PUBLIC_SOURCE_NOTICE,
  PublicSourceError,
  type PublicSourceAnswer,
  type PublicSourceItem,
  type PublicSourceQuery,
} from './public-source.js';

/**
 * How a call is answered (ADR-0170 D4): one function for the tool and for the demo's records
 * stand-in. {@link answerPublicSource} closes over nothing: every helper is nested inside it, and
 * it reads only standard globals and its arguments. Its source text is therefore a complete
 * program, whatever a minifier renames, and {@link PUBLIC_SOURCE_SNAPSHOT_SCRIPT} embeds that text
 * under a name of its own. The tool calls the function; the stand-in runs the same text.
 */

/** What the answer function is given instead of reading this module's constants. */
export interface PublicSourceSelectConstants {
  readonly queryCharacters: number;
  readonly sourceCharacters: number;
  readonly itemsPerAnswer: number;
  readonly defaultItemsPerAnswer: number;
  readonly matchesKept: number;
  readonly notice: typeof PUBLIC_SOURCE_NOTICE;
}

export const PUBLIC_SOURCE_SELECT_CONSTANTS: PublicSourceSelectConstants = Object.freeze({
  queryCharacters: PUBLIC_SOURCE_LIMITS.queryCharacters,
  sourceCharacters: PUBLIC_SOURCE_LIMITS.sourceCharacters,
  itemsPerAnswer: PUBLIC_SOURCE_LIMITS.itemsPerAnswer,
  defaultItemsPerAnswer: PUBLIC_SOURCE_LIMITS.defaultItemsPerAnswer,
  matchesKept: PUBLIC_SOURCE_LIMITS.matchesKept,
  notice: PUBLIC_SOURCE_NOTICE,
});

/** What {@link answerPublicSource} gives: the answer and the checked query, or a refusal. */
export type PublicSourceSelection =
  | { readonly answer: PublicSourceAnswer; readonly query: PublicSourceQuery }
  | { readonly error: true };

/**
 * The answer to a call's `args` over `items`, as of `frame.asOf`, or `{ error: true }` when the
 * arguments are not a query (the rules of `PublicSourceQuerySchema`, checked by hand because this
 * runs where zod is not). The arguments are checked before any item is read, so a pass over no
 * items checks them alone.
 *
 * The items are read once, in order, and only the ones that answer are kept (at most
 * `matchesKept`): those whose title, summary, id or field values hold the words (case ignored), of
 * the source, published at or after `since` (compared as instants, so offsets count). They are
 * sorted newest first, undated last in the source's order, and cut to the limit (20 by default).
 * `truncated` says that more items answered than the answer carries.
 */
export function answerPublicSource(
  items: Iterable<PublicSourceItem>,
  args: unknown,
  frame: { readonly mode: 'snapshot' | 'live'; readonly asOf: string },
  constants: PublicSourceSelectConstants,
): PublicSourceSelection {
  const checked = (): PublicSourceQuery | null => {
    if (args === undefined || args === null) return {};
    if (typeof args !== 'object' || Array.isArray(args)) return null;
    const query: { query?: string; source?: string; since?: string; limit?: number } = {};
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined) continue;
      if (key === 'query' || key === 'source') {
        const max = key === 'query' ? constants.queryCharacters : constants.sourceCharacters;
        if (typeof value !== 'string' || value.length > max) return null;
        query[key] = value;
      } else if (key === 'since') {
        const iso = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/u;
        const day = typeof value === 'string' ? iso.exec(value)?.[1] : undefined;
        const midnight = Date.parse(`${String(day)}T00:00:00Z`);
        // A real calendar day (no 30 February), and a time that parses.
        const real =
          day !== undefined &&
          !Number.isNaN(midnight) &&
          new Date(midnight).toISOString().startsWith(day);
        if (!real || Number.isNaN(Date.parse(String(value)))) return null;
        query.since = String(value);
      } else if (key === 'limit') {
        const limit = Number(value);
        if (!Number.isInteger(value) || limit < 1 || limit > constants.itemsPerAnswer) return null;
        query.limit = limit;
      } else {
        return null;
      }
    }
    return query;
  };
  const query = checked();
  if (query === null) return { error: true };
  const words = (query.query ?? '').trim().toLowerCase();
  const source = (query.source ?? '').trim().toLowerCase();
  const since = query.since === undefined ? null : Date.parse(query.since);
  // Earlier than any date, so an undated item sorts last and never passes `since`.
  const undated = Number.MIN_SAFE_INTEGER;
  const kept: { readonly item: PublicSourceItem; readonly time: number }[] = [];
  let matched = 0;
  for (const item of items) {
    const time = item.publishedAt === null ? undated : Date.parse(item.publishedAt);
    if (since !== null && time < since) continue;
    if (source !== '' && item.source.toLowerCase() !== source) continue;
    if (words !== '') {
      const text = [item.id, item.title, item.summary, ...Object.values(item.fields ?? {})]
        .map((part) => (part === undefined || part === null ? '' : String(part)))
        .join(' ')
        .toLowerCase();
      if (!text.includes(words)) continue;
    }
    matched += 1;
    if (kept.length < constants.matchesKept) kept.push({ item, time });
  }
  kept.sort((a, b) => b.time - a.time);
  const records = kept
    .slice(0, query.limit ?? constants.defaultItemsPerAnswer)
    .map((entry) => entry.item);
  return {
    query,
    answer: {
      mode: frame.mode,
      asOf: frame.asOf,
      notice: constants.notice,
      truncated: matched > records.length,
      records,
    },
  };
}

/**
 * The selection as a script for a process with no import (the demo's records stand-in). It defines
 * `answerPublicSourceSnapshot(snapshot, args)`, which answers as the tool's snapshot mode does, and
 * `PUBLIC_SOURCE_QUERY_INVALID`, the refusal's text. The function's own name in the text is never
 * used, so a minified build works the same (pinned by `packages/aw/src/tools/public-source-minified.test.ts`).
 */
export const PUBLIC_SOURCE_SNAPSHOT_SCRIPT = [
  `const publicSourceAnswer = ${answerPublicSource.toString()};`,
  `const PUBLIC_SOURCE_CONSTANTS = ${JSON.stringify(PUBLIC_SOURCE_SELECT_CONSTANTS)};`,
  `const PUBLIC_SOURCE_QUERY_INVALID = ${JSON.stringify(new PublicSourceError('query_invalid').message)};`,
  "const answerPublicSourceSnapshot = (snapshot, args) => publicSourceAnswer(snapshot.items, args, { mode: 'snapshot', asOf: snapshot.asOf }, PUBLIC_SOURCE_CONSTANTS);",
].join('\n');
