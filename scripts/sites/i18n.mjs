// The Japanese marketing site, made from the English pages and one strings file per page, so no
// page's markup is written twice. The English page is the source; a translation unit is a run of
// text with its inline markup (a heading, a paragraph with its links and <code>, a button label),
// keyed by its English HTML with the whitespace collapsed. sites/lp/_i18n/ja/<page>.json holds the
// units of that page and common.json the units several pages share (the header and footer).
//
// What is never translated: <pre>, <script>, <style>, <svg> and <textarea> contents, <code>/<kbd>
// text, anything under translate="no", and a unit with no Latin letter outside those. A build-time
// slot keeps its markers and its English contents (`<!-- data:x -->…<!-- /data:x -->`, filled per
// language by store-data.mjs, and the gallery's `<!-- benchmark:score x -->95<!-- benchmark:end -->`).
//
// A unit or attribute without a Japanese string, and a string no page uses, are problems: an
// English edit fails `tests/sites/i18n.test.ts` until its Japanese follows.
// Usage: node scripts/sites/i18n.mjs --missing   (prints the missing strings, per page, as JSON)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SITE = resolve(import.meta.dirname, '..', '..', 'sites', 'lp');
const STRINGS = join(SITE, '_i18n', 'ja');
/** The strings file every page reads after its own. */
export const COMMON = 'common';
const ORIGIN = 'https://lp.agentworkspace.indx.jp';

const TOKEN =
  /<!--[\s\S]*?-->|<![A-Za-z][^>]*>|<\/?[A-Za-z][^\s/>]*(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>|[^<]+|</gu;
/** Elements whose contents are never text to translate; the region is copied as it is. */
const RAW = new Set(['pre', 'script', 'style', 'svg', 'textarea']);
/** Elements that sit inside a run of text; any other tag ends the run. */
const INLINE = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'br',
  'button',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'i',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
]);
const VOID = new Set(['br', 'img', 'input', 'wbr', 'meta', 'link', 'hr', 'source', 'area', 'col']);
/** Inline elements whose text is code, not words. */
const CODE = new Set(['code', 'kbd', 'samp']);
/** The attributes a reader or a screen reader sees. */
const TEXT_ATTRIBUTES = ['alt', 'title', 'placeholder', 'aria-label'];
/** The <meta> whose `content` is words. */
const TEXT_META = /\b(?:name="description"|property="og:(?:title|description|image:alt)")/u;
const SLOT =
  /(<!-- (data:[a-z-]+)[^>]*?-->)[\s\S]*?(<!-- \/\2 -->)|(<!-- benchmark:score [a-z-]+ -->)[^<]*(<!-- benchmark:end -->)/gu;
const LATIN = /[A-Za-z]/u;
/** A comment that opens or closes a slot: part of the sentence it sits in. */
const SLOT_MARKER = /^<!-- (?:\/?data:|benchmark:)/u;

/**
 * @typedef {{ kind: 'text' | 'comment' | 'atom' | 'open' | 'close', raw: string, name: string }} Token
 * @typedef {{ key: string, raw: string }} Unit
 * @typedef {Readonly<Record<string, string>>} Strings
 */

/** @param {string} html @returns {Token[]} */
function tokenize(html) {
  return [...html.matchAll(TOKEN)].map(([raw]) => {
    if (raw.startsWith('<!--')) return { kind: 'comment', raw, name: '' };
    if (raw.startsWith('<!')) return { kind: 'open', raw, name: '!doctype' };
    const tag = /^<(\/?)([A-Za-z][^\s/>]*)/u.exec(raw);
    if (tag === null) return { kind: 'text', raw, name: '' };
    return { kind: tag[1] === '/' ? 'close' : 'open', raw, name: (tag[2] ?? '').toLowerCase() };
  });
}

/** @param {Token} token */
const translateNo = (token) => token.kind === 'open' && /\btranslate="no"/u.test(token.raw);

/** @param {string} html The run's HTML with every slot emptied and whitespace collapsed. */
export function unitKey(html) {
  return html
    .replace(SLOT, (_, open, _name, close, scoreOpen, scoreClose) =>
      open === undefined ? `${String(scoreOpen)}${String(scoreClose)}` : `${open}${close}`,
    )
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * The words of a run a reader sees: its text without tags, code and translate="no" parts.
 * @param {readonly Token[]} tokens
 */
function wordsOf(tokens) {
  let words = '';
  let hidden = 0;
  for (const token of tokens) {
    if (
      token.kind === 'open' &&
      !VOID.has(token.name) &&
      (CODE.has(token.name) || hidden > 0 || translateNo(token))
    )
      hidden += 1;
    else if (token.kind === 'close' && hidden > 0) hidden -= 1;
    else if (token.kind === 'text' && hidden === 0) words += token.raw;
  }
  return words;
}

/**
 * The top-level inline elements of a run with no text of its own, or null when the run has text
 * outside an element or its tags do not balance.
 * @param {readonly Token[]} tokens
 * @returns {{ open: Token, inner: Token[], close: Token | null }[] | null}
 */
function topElements(tokens) {
  /** @type {{ open: Token, inner: Token[], close: Token | null }[]} */
  const elements = [];
  let depth = 0;
  for (const token of tokens) {
    if (depth === 0) {
      if (token.kind === 'text' && token.raw.trim() !== '') return null;
      if (token.kind === 'close') return null;
      if (token.kind === 'atom') elements.push({ open: token, inner: [], close: null });
      if (token.kind === 'open') {
        elements.push({ open: token, inner: [], close: null });
        if (!VOID.has(token.name)) depth = 1;
      }
      continue;
    }
    const current = elements.at(-1);
    if (current === undefined) return null;
    if (token.kind === 'open' && !VOID.has(token.name)) depth += 1;
    if (token.kind === 'close') depth -= 1;
    if (depth === 0) current.close = token;
    else current.inner.push(token);
  }
  return depth === 0 ? elements : null;
}

/**
 * Splits a run into the units it holds. `emit` receives each piece of output in order: a unit (to
 * translate) or raw HTML (to copy).
 * @param {readonly Token[]} run
 * @param {(piece: { unit: Unit } | { raw: string }) => void} emit
 */
function splitRun(run, emit) {
  const raw = run.map((token) => token.raw).join('');
  if (!LATIN.test(wordsOf(run))) {
    emit({ raw });
    return;
  }
  const elements = topElements(run);
  if (elements === null) {
    // Whitespace, comments, icons and void tags at either end stay outside the unit.
    /** @param {Token | undefined} token */
    const edge = (token) =>
      token !== undefined &&
      ((token.kind === 'text' && token.raw.trim() === '') ||
        (token.kind === 'comment' && !SLOT_MARKER.test(token.raw)) ||
        token.kind === 'atom' ||
        (token.kind === 'open' && VOID.has(token.name)));
    let first = 0;
    let last = run.length;
    while (first < last && edge(run[first])) first += 1;
    while (last > first && edge(run[last - 1])) last -= 1;
    const join = (/** @type {readonly Token[]} */ tokens) => tokens.map((t) => t.raw).join('');
    const body = join(run.slice(first, last));
    const lead = /^\s*/u.exec(body)?.[0] ?? '';
    const trail = /\s*$/u.exec(body)?.[0] ?? '';
    emit({ raw: join(run.slice(0, first)) + lead });
    emit({
      unit: { key: unitKey(body), raw: body.slice(lead.length, body.length - trail.length) },
    });
    emit({ raw: trail + join(run.slice(last)) });
    return;
  }
  let at = 0;
  for (const element of elements) {
    const start = run.indexOf(element.open, at);
    emit({
      raw: run
        .slice(at, start + 1)
        .map((token) => token.raw)
        .join(''),
    });
    if (CODE.has(element.open.name) || translateNo(element.open))
      emit({ raw: element.inner.map((t) => t.raw).join('') });
    else splitRun(element.inner, emit);
    at = start + 1 + element.inner.length;
    if (element.close !== null) {
      emit({ raw: element.close.raw });
      at += 1;
    }
  }
  emit({
    raw: run
      .slice(at)
      .map((token) => token.raw)
      .join(''),
  });
}

/**
 * Walks a page, copying markup and handing each translation unit to `translate`.
 * @param {string} html
 * @param {(unit: Unit) => string} translate
 * @returns {string}
 */
function walk(html, translate) {
  const tokens = tokenize(html);
  let out = '';
  /** @type {Token[]} */
  let run = [];
  const flush = () => {
    splitRun(run, (piece) => {
      out += 'unit' in piece ? translate(piece.unit) : piece.raw;
    });
    run = [];
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = /** @type {Token} */ (tokens[index]);
    const opensRaw =
      token.kind === 'open' &&
      (RAW.has(token.name) || (translateNo(token) && !INLINE.has(token.name)));
    const opensData = token.kind === 'comment' && /^<!-- data:([a-z-]+)/u.exec(token.raw);
    if (opensRaw || (opensData && !run.some((t) => t.kind === 'text' && t.raw.trim() !== ''))) {
      const close = opensData ? `<!-- /data:${opensData[1] ?? ''} -->` : null;
      let depth = 0;
      let end = index;
      for (; end < tokens.length; end += 1) {
        const inner = /** @type {Token} */ (tokens[end]);
        if (close !== null) {
          if (inner.raw === close) break;
          continue;
        }
        if (inner.kind === 'open' && inner.name === token.name && !VOID.has(inner.name)) depth += 1;
        if (inner.kind === 'close' && inner.name === token.name) depth -= 1;
        if (depth === 0) break;
      }
      const inRegion = tokens.slice(index, end + 1);
      const region = inRegion.map((t) => t.raw).join('');
      const next = tokens.slice(end + 1).find((t) => t.kind !== 'text' || t.raw.trim() !== '');
      index = end;
      // An icon sits inside a run of text, and so does a slot that text follows (a count that
      // starts a sentence); the other regions end the run.
      if (token.name === 'svg') run.push({ kind: 'atom', raw: region, name: 'svg' });
      else if (opensData && next?.kind === 'text') run.push(...inRegion);
      else {
        flush();
        out += region;
      }
      continue;
    }
    if (token.kind === 'text' || token.kind === 'comment' || INLINE.has(token.name)) {
      run.push(token);
      continue;
    }
    flush();
    out += token.raw;
  }
  flush();
  return out;
}

/** @param {string} html @returns {Unit[]} Every translation unit of a page, in order. */
export function pageUnits(html) {
  /** @type {Unit[]} */
  const units = [];
  walk(html, (unit) => {
    units.push(unit);
    return unit.raw;
  });
  return units;
}

/**
 * Puts the English contents of each slot of `english` into the same slot of `translated`, so a
 * translation never carries a value of its own.
 * @param {string} english @param {string} translated
 */
function refillSlots(english, translated) {
  /** @param {string} slot The slot's opening marker, which names it. */
  const opening = (slot) => /^<!--[^>]*-->/u.exec(slot)?.[0] ?? slot;
  const values = new Map([...english.matchAll(SLOT)].map(([slot]) => [opening(slot), slot]));
  // A translation may put the slots in another order; each one keeps its own value.
  return translated.replace(SLOT, (slot) => values.get(opening(slot)) ?? slot);
}

/**
 * @param {string} page The page's file name.
 * @param {string} html The English page.
 * @param {(key: string) => string | undefined} lookup
 * @returns {{ html: string, missing: string[] }}
 */
export function translatePage(page, html, lookup) {
  /** @type {string[]} */
  const missing = [];
  const body = walk(html, (unit) => {
    const ja = lookup(unit.key);
    if (ja === undefined) {
      missing.push(unit.key);
      return unit.raw;
    }
    return refillSlots(unit.raw, ja);
  });
  const withAttributes = body.replace(
    /<[A-Za-z][^\s/>]*(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>/gu,
    (tag) => {
      const names = tag.startsWith('<meta')
        ? TEXT_META.test(tag)
          ? ['content']
          : []
        : TEXT_ATTRIBUTES;
      let out = tag;
      for (const name of names) {
        out = out.replace(
          new RegExp(`(\\s${name}=")([^"]*)(")`, 'u'),
          (whole, open, value, close) => {
            if (!LATIN.test(value)) return whole;
            const ja = lookup(value);
            if (ja === undefined) {
              missing.push(value);
              return whole;
            }
            return `${open}${ja}${close}`;
          },
        );
      }
      return out;
    },
  );
  return { html: localizeChrome(page, withAttributes), missing };
}

/**
 * The page-level changes of the Japanese copy: the language, the asset paths one folder down, the
 * canonical URL, and the switch back to English.
 * @param {string} page @param {string} html
 */
function localizeChrome(page, html) {
  return html
    .replace(/<html lang="en">/u, '<html lang="ja">')
    .replace(/(\s(?:href|src)=")assets\//gu, '$1../assets/')
    .replaceAll(
      `<link rel="canonical" href="${ORIGIN}/`,
      `<link rel="canonical" href="${ORIGIN}/ja/`,
    )
    .replaceAll(
      `<meta property="og:url" content="${ORIGIN}/`,
      `<meta property="og:url" content="${ORIGIN}/ja/`,
    )
    .replaceAll(
      `href="ja/${page}" hreflang="ja" lang="ja">日本語</a>`,
      `href="../${page}" hreflang="en" lang="en">English</a>`,
    );
}

/**
 * The page's URL in each language, for `<link rel="alternate" hreflang>`.
 * @param {string} page
 */
export function alternates(page) {
  const path = page === 'index.html' ? '' : page;
  return [
    `<link rel="alternate" hreflang="en" href="${ORIGIN}/${path}">`,
    `<link rel="alternate" hreflang="ja" href="${ORIGIN}/ja/${path}">`,
  ].join('\n');
}

/** @param {string} html @param {string} page Adds the hreflang links after the canonical one. */
export function withAlternates(html, page) {
  return html.replace(/(<link rel="canonical"[^>]*>)/u, `$1\n${alternates(page)}`);
}

/** @param {string} name @returns {Record<string, string>} */
function readStrings(name) {
  const path = join(STRINGS, `${name}.json`);
  if (!existsSync(path)) return {};
  const parsed = /** @type {unknown} */ (JSON.parse(readFileSync(path, 'utf8')));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${path}: expected an object of English to Japanese strings`);
  for (const [key, value] of Object.entries(parsed))
    if (typeof value !== 'string' || value.trim() === '')
      throw new Error(`${path}: ${JSON.stringify(key)} has no Japanese string`);
  return /** @type {Record<string, string>} */ (parsed);
}

/** @returns {string[]} The pages of the site, by file name. */
export function sitePages() {
  return readdirSync(SITE)
    .filter((name) => name.endsWith('.html'))
    .sort();
}

/**
 * Translates every page of the site.
 * @returns {{ pages: Map<string, string>, missing: Map<string, string[]>, stale: string[] }}
 */
export function translateSite() {
  const common = readStrings(COMMON);
  const usedCommon = new Set();
  /** @type {Map<string, string>} */
  const pages = new Map();
  /** @type {Map<string, string[]>} */
  const missing = new Map();
  /** @type {string[]} */
  const stale = [];
  for (const page of sitePages()) {
    const own = readStrings(page.replace(/\.html$/u, ''));
    const usedOwn = new Set();
    const result = translatePage(page, readFileSync(join(SITE, page), 'utf8'), (key) => {
      if (key in own) {
        usedOwn.add(key);
        return own[key];
      }
      if (key in common) {
        usedCommon.add(key);
        return common[key];
      }
      return undefined;
    });
    pages.set(page, result.html);
    if (result.missing.length > 0) missing.set(page, [...new Set(result.missing)]);
    for (const key of Object.keys(own))
      if (!usedOwn.has(key)) stale.push(`_i18n/ja/${page.replace(/\.html$/u, '')}.json: ${key}`);
  }
  for (const key of Object.keys(common))
    if (!usedCommon.has(key)) stale.push(`_i18n/ja/${COMMON}.json: ${key}`);
  return { pages, missing, stale };
}

/** @returns {string[]} One line per missing or unused string. */
export function siteTranslationProblems() {
  const { missing, stale } = translateSite();
  return [
    ...[...missing].flatMap(([page, keys]) =>
      keys.map((key) => `${page}: no Japanese string for ${JSON.stringify(key)}`),
    ),
    ...stale.map((line) => `unused Japanese string in ${line}`),
  ];
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  if (process.argv[2] !== '--missing')
    throw new Error('usage: node scripts/sites/i18n.mjs --missing');
  const { missing } = translateSite();
  /** @type {Map<string, string[]>} */
  const pagesOf = new Map();
  for (const [page, keys] of missing)
    for (const key of keys) pagesOf.set(key, [...(pagesOf.get(key) ?? []), page]);
  /** @type {Record<string, Record<string, string>>} */
  const out = {};
  for (const [key, pages] of pagesOf) {
    const file = pages.length > 1 ? COMMON : (pages[0] ?? COMMON).replace(/\.html$/u, '');
    out[file] = { ...out[file], [key]: '' };
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}
