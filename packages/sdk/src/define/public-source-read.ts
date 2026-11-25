import { parsePublicFeed } from './public-source-feed.js';
import { PUBLIC_SOURCE_SELECT_CONSTANTS, answerPublicSource } from './public-source-select.js';
import { parsePublicTable } from './public-source-table.js';
import {
  PUBLIC_SOURCE_CONTENT_TYPES,
  PUBLIC_SOURCE_LIMITS,
  PublicSourceError,
  type PublicSourceAnswer,
  type PublicSourceConfig,
  type PublicSourceFeed,
  type PublicSourceItem,
  type PublicSourceQuery,
} from './public-source.js';

/** What a read is given rather than reaching for globals, so a test can drive every path. */
export interface PublicSourceDependencies {
  /** Reads a live source. Never called in `snapshot` mode. */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The time a live read records as each item's `retrievedAt` and as the answer's `asOf`. */
  readonly now: () => Date;
  /**
   * The hosts this tool may reach, exactly: the tool's declared `allowedDomains`, which the tool
   * sandbox's egress allowlist enforces too (ADR-0118 TS5). A source whose host is not here is
   * refused as `network_not_allowed` before any request, and an empty list means no request at all.
   */
  readonly allowedDomains: readonly string[];
  /** Aborted when the call is cancelled or times out. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * The response's bytes, refused once they pass the source's byte limit (never cut); a broken
 * stream is unreachable.
 */
async function boundedBytes(response: Response, feed: PublicSourceFeed): Promise<Uint8Array> {
  const most = feed.maxBytes ?? PUBLIC_SOURCE_LIMITS.responseBytes;
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > most) {
    throw new PublicSourceError('source_too_large', feed.name);
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let step: Awaited<ReturnType<typeof reader.read>>;
    try {
      step = await reader.read();
    } catch {
      throw new PublicSourceError('source_unreachable', feed.name);
    }
    if (step.done) break;
    total += step.value.byteLength;
    if (total > most) {
      // The source is refused either way; a stream that fails to cancel changes nothing.
      await reader.cancel().catch(() => undefined);
      throw new PublicSourceError('source_too_large', feed.name);
    }
    chunks.push(step.value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** The bytes a document's encoding declaration may sit in. */
const DECLARATION_BYTES = 256;

/**
 * The text of `bytes`, in the charset the `Content-Type` names, else the one an XML declaration
 * names, else UTF-8 (so Shift_JIS and EUC-JP sources read as they are). An unknown charset, or
 * bytes that are not of it, is refused as `source_encoding` rather than read as replacement
 * characters.
 */
function decoded(bytes: Uint8Array, contentType: string, feed: PublicSourceFeed): string {
  const head = String.fromCharCode(...bytes.subarray(0, DECLARATION_BYTES));
  const label =
    /;\s*charset\s*=\s*"?([A-Za-z0-9._:-]+)/iu.exec(contentType)?.[1] ??
    /^(?:\xEF\xBB\xBF)?\s*<\?xml\s[^>]*encoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/u.exec(
      head,
    )?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    throw new PublicSourceError('source_encoding', feed.name);
  }
}

/** One live source's text, as it was served. */
interface Fetched {
  readonly feed: PublicSourceFeed;
  readonly mediaType: string;
  readonly body: string;
}

/** Reads one live source's text. */
async function fetchFeed(feed: PublicSourceFeed, deps: PublicSourceDependencies): Promise<Fetched> {
  if (!deps.allowedDomains.includes(new URL(feed.url).hostname)) {
    throw new PublicSourceError('network_not_allowed', feed.name);
  }
  const accepted = PUBLIC_SOURCE_CONTENT_TYPES[feed.format];
  const timeout = AbortSignal.timeout(PUBLIC_SOURCE_LIMITS.fetchTimeoutMs);
  let response: Response;
  try {
    response = await deps.fetch(feed.url, {
      method: 'GET',
      headers: { accept: accepted.join(', ') },
      credentials: 'omit',
      // A redirect could leave the declared host; it is refused rather than followed.
      redirect: 'error',
      signal: deps.signal === undefined ? timeout : AbortSignal.any([deps.signal, timeout]),
    });
  } catch {
    throw new PublicSourceError('source_unreachable', feed.name);
  }
  if (!response.ok) throw new PublicSourceError('source_status', feed.name);
  const contentType = response.headers.get('content-type') ?? '';
  const mediaType = contentType.replace(/;.*$/su, '').trim().toLowerCase();
  if (!accepted.includes(mediaType)) {
    throw new PublicSourceError('source_content_type', feed.name);
  }
  return { feed, mediaType, body: decoded(await boundedBytes(response, feed), contentType, feed) };
}

/** The items of the sources' texts, one at a time, each source parsed only when it is reached. */
function* itemsOfAll(
  fetched: readonly Fetched[],
  retrievedAt: string,
): Generator<PublicSourceItem, void, undefined> {
  for (const { feed, mediaType, body } of fetched) {
    if (feed.format === 'feed' || feed.mapping === undefined) {
      yield* parsePublicFeed(body, mediaType, feed, retrievedAt);
    } else {
      yield* parsePublicTable(body, { ...feed, mapping: feed.mapping }, retrievedAt);
    }
  }
}

/** The answer of `items` to `query`, or the typed refusal of a query that is not one. */
function answered(
  items: Iterable<PublicSourceItem>,
  query: PublicSourceQuery,
  frame: { readonly mode: 'snapshot' | 'live'; readonly asOf: string },
): PublicSourceAnswer {
  const result = answerPublicSource(items, query, frame, PUBLIC_SOURCE_SELECT_CONSTANTS);
  if ('error' in result) throw new PublicSourceError('query_invalid');
  return result.answer;
}

/**
 * Answers one call (ADR-0170) with `answerPublicSource`, the code the demo's stand-in runs too. In
 * `snapshot` mode the answer is the snapshot's and `deps.fetch` is never called. In `live` mode the
 * query is checked first; then each source the call can match is read through `deps.fetch`, at the
 * same time, within `deps.allowedDomains`, and every item of it is searched: none is dropped before
 * the query sees it, and `truncated` says when more answered than the answer carries. A source that
 * fails refuses the whole call with its {@link PublicSourceError}, so an answer is never silently
 * partial.
 */
export async function readPublicSource(
  config: PublicSourceConfig,
  query: PublicSourceQuery,
  deps: PublicSourceDependencies,
): Promise<PublicSourceAnswer> {
  if (config.mode === 'snapshot') {
    return answered(config.snapshot.items, query, { mode: 'snapshot', asOf: config.snapshot.asOf });
  }
  const retrievedAt = deps.now().toISOString();
  const frame = { mode: 'live', asOf: retrievedAt } as const;
  answered([], query, frame);
  const source = query.source?.trim().toLowerCase() ?? '';
  const feeds = config.feeds.filter((feed) => source === '' || feed.name.toLowerCase() === source);
  const fetched = await Promise.all(feeds.map((feed) => fetchFeed(feed, deps)));
  return answered(itemsOfAll(fetched, retrievedAt), query, frame);
}
