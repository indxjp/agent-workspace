import { z } from 'zod';

import {
  PUBLIC_SOURCE_LIMITS,
  PublicSourceError,
  PublicSourceItemSchema,
  type PublicSourceFeed,
  type PublicSourceItem,
} from './public-source.js';

/**
 * Turns one live source's text into items (ADR-0170 D5). The text is untrusted: it is parsed,
 * never evaluated; markup is stripped to plain text; text is cut to the limits; and an item without
 * a web URL or a title is dropped. Text that is no feed at all is refused as `source_invalid`.
 *
 * JSON Feed 1.x is parsed with `JSON.parse` and a schema. RSS 2.0 and Atom are read by a scanner
 * rather than an XML parser (the SDK carries no XML library). Every scan only moves forward, with
 * `indexOf` and patterns that cannot backtrack across a `<`, so a hostile megabyte costs linear
 * time (pinned by a timing test). A document type declaration before the root is refused, so no
 * entity is ever defined: only the five predefined ones and character references are decoded.
 */

/** What a parser gives for one item, before it is checked. */
export interface ItemDraft {
  readonly id?: string | undefined;
  readonly url: string | undefined;
  readonly title: string | undefined;
  readonly summary: string | undefined;
  readonly published: string | undefined;
  readonly fields?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** The largest Unicode code point; a character reference above it is dropped. */
const MAX_CODE_POINT = 0x10_ff_ff;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,8}|#[0-9]{1,8}|[a-z]{1,10});/giu, (whole, name: string) => {
    if (name.startsWith('#')) {
      const hex = name[1] === 'x' || name[1] === 'X';
      const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= MAX_CODE_POINT ? String.fromCodePoint(code) : '';
    }
    return PREDEFINED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** A tag: `<`, then anything but `<` and `>`, then `>`. It never backtracks across a `<`. */
const TAG = /<[^<>]*>/gu;

/**
 * Plain text: markup, control and format characters (bidi overrides, zero-width characters)
 * removed, white space collapsed. Markup is stripped before and after entities are decoded,
 * because a source may carry HTML escaped (`&lt;p&gt;`).
 */
function plainText(text: string): string {
  return decodeEntities(text.replace(TAG, ' '))
    .replace(TAG, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** `text` cut to `max` characters, at the last space when there is one, with an ellipsis. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(' ');
  return `${space > 0 ? head.slice(0, space) : head}…`;
}

/** The ISO form of a date the source gave, or `null` when it gave none or one that does not parse. */
function isoDate(value: string | number | boolean | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value.trim());
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** A draft as a checked item, or `null` when it is not one (no title, no web URL, a bad field). */
function itemOf(
  draft: ItemDraft,
  feed: PublicSourceFeed,
  retrievedAt: string,
): PublicSourceItem | null {
  const fields =
    draft.fields === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(draft.fields).map(([key, value]) => [
            key,
            typeof value === 'string'
              ? cut(plainText(value), PUBLIC_SOURCE_LIMITS.fieldCharacters)
              : value,
          ]),
        );
  const id = draft.id === undefined ? '' : plainText(draft.id);
  const parsed = PublicSourceItemSchema.safeParse({
    ...(id === '' ? {} : { id: cut(id, PUBLIC_SOURCE_LIMITS.idCharacters) }),
    source: feed.name,
    url: decodeEntities(draft.url ?? '').trim(),
    title: cut(plainText(draft.title ?? ''), PUBLIC_SOURCE_LIMITS.titleCharacters),
    summary: cut(plainText(draft.summary ?? ''), PUBLIC_SOURCE_LIMITS.summaryCharacters),
    publishedAt: isoDate(draft.published),
    retrievedAt,
    ...(fields === undefined ? {} : { fields }),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The checked items of `drafts`, one at a time: the caller reads them once and keeps only the ones
 * that answer its query (`answerPublicSource`), so no item is dropped before it is searched.
 */
export function* itemsOf(
  drafts: Iterable<ItemDraft>,
  feed: PublicSourceFeed,
  retrievedAt: string,
): Generator<PublicSourceItem, void, undefined> {
  for (const draft of drafts) {
    const item = itemOf(draft, feed, retrievedAt);
    if (item !== null) yield item;
  }
}

const JsonFeedSchema = z.object({
  version: z.string().startsWith('https://jsonfeed.org/version/1'),
  items: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).optional(),
      url: z.string().optional(),
      external_url: z.string().optional(),
      title: z.string().optional(),
      summary: z.string().optional(),
      content_text: z.string().optional(),
      content_html: z.string().optional(),
      date_published: z.string().optional(),
    }),
  ),
});

/** The parsed JSON of `body`, refused as `source_invalid` when it does not parse. */
export function parsedJson(body: string, source: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new PublicSourceError('source_invalid', source);
  }
}

function jsonFeedDrafts(body: string, source: string): readonly ItemDraft[] {
  const parsed = JsonFeedSchema.safeParse(parsedJson(body, source));
  if (!parsed.success) throw new PublicSourceError('source_invalid', source);
  return parsed.data.items.map((item) => ({
    id: item.id === undefined ? undefined : String(item.id),
    url: item.url ?? item.external_url,
    title: item.title,
    summary: item.summary ?? item.content_text ?? item.content_html,
    published: item.date_published,
  }));
}

/** Finds the next `<` or `>`; global, so its `lastIndex` says where the scan starts. */
const ANGLE = /[<>]/gu;

/**
 * The opening tag `<name ...>` at or after `from`: where it starts and where its `>` is. A
 * candidate whose `<` is followed by more of a name (`<items>` for `item`), or whose tag meets
 * another `<` before its `>`, is skipped. Each character is looked at a bounded number of times.
 */
function openingTag(
  text: string,
  name: string,
  from: number,
): { readonly start: number; readonly end: number } | null {
  const open = `<${name}`;
  for (let start = text.indexOf(open, from); start !== -1; start = text.indexOf(open, start + 1)) {
    const after = text.charAt(start + open.length);
    if (after !== '>' && after !== '/' && !/\s/u.test(after)) continue;
    ANGLE.lastIndex = start + 1;
    const next = ANGLE.exec(text);
    if (next === null) return null;
    if (next[0] === '>') return { start, end: next.index };
  }
  return null;
}

/** The contents of each `<name>…</name>` element of `text`, in order (`''` for `<name/>`). */
function elementsOf(text: string, name: string, most = Number.POSITIVE_INFINITY): string[] {
  const close = `</${name}>`;
  const found: string[] = [];
  let from = 0;
  while (found.length < most) {
    const tag = openingTag(text, name, from);
    if (tag === null) break;
    if (text.charAt(tag.end - 1) === '/') {
      found.push('');
      from = tag.end;
      continue;
    }
    const closing = text.indexOf(close, tag.end);
    if (closing === -1) break;
    found.push(text.slice(tag.end + 1, closing));
    from = closing + close.length;
  }
  return found;
}

/** `text` with each `<![CDATA[…]]>` section replaced by its contents. */
function unwrapCdata(text: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const open = text.indexOf('<![CDATA[', at);
    const close = open === -1 ? -1 : text.indexOf(']]>', open);
    if (close === -1) return out + text.slice(at);
    out += text.slice(at, open) + text.slice(open + '<![CDATA['.length, close);
    at = close + ']]>'.length;
  }
}

/** The text of the first `<name>` element in `block`, CDATA unwrapped, or `undefined`. */
function element(block: string, name: string): string | undefined {
  const [inner] = elementsOf(block, name, 1);
  return inner === undefined ? undefined : unwrapCdata(inner);
}

/** Atom's link: the `href` of the `alternate` link (or of one with no `rel`). */
function atomLink(block: string): string | undefined {
  for (
    let tag = openingTag(block, 'link', 0);
    tag !== null;
    tag = openingTag(block, 'link', tag.end)
  ) {
    const attributes = block.slice(tag.start, tag.end);
    const rel = /\srel\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(attributes);
    const href = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(attributes);
    const relValue = rel === null ? undefined : (rel[1] ?? rel[2]);
    if (href !== null && (relValue === undefined || relValue === 'alternate')) {
      return href[1] ?? href[2];
    }
  }
  return undefined;
}

function xmlDrafts(body: string, source: string): readonly ItemDraft[] {
  const rss = openingTag(body, 'rss', 0);
  const feed = openingTag(body, 'feed', 0);
  const root = rss ?? feed;
  // Only the prolog can declare a document type; CDATA inside the root can only mention one.
  if (root === null || /<!DOCTYPE|<!ENTITY/iu.test(body.slice(0, root.start))) {
    throw new PublicSourceError('source_invalid', source);
  }
  if (root === rss) {
    return elementsOf(body, 'item').map((block) => ({
      id: element(block, 'guid'),
      url: element(block, 'link'),
      title: element(block, 'title'),
      summary: element(block, 'description'),
      published: element(block, 'pubDate'),
    }));
  }
  return elementsOf(body, 'entry').map((block) => ({
    id: element(block, 'id'),
    url: atomLink(block),
    title: element(block, 'title'),
    summary: element(block, 'summary') ?? element(block, 'content'),
    published: element(block, 'published') ?? element(block, 'updated'),
  }));
}

/**
 * The items of one feed's `body`, given the media type it was served as (one of the feed format's
 * content types), one at a time.
 *
 * @throws {PublicSourceError} `source_invalid`, when read, if the body is not a feed of that type.
 */
export function* parsePublicFeed(
  body: string,
  mediaType: string,
  feed: PublicSourceFeed,
  retrievedAt: string,
): Generator<PublicSourceItem, void, undefined> {
  const drafts = mediaType.endsWith('json')
    ? jsonFeedDrafts(body, feed.name)
    : xmlDrafts(body, feed.name);
  yield* itemsOf(drafts, feed, retrievedAt);
}
