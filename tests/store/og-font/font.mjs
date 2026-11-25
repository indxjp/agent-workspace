/**
 * The social cards' font (use-cases plan §6.3): where it lives, which characters it must hold, and
 * the record `subset.mjs` writes and `tests/store/og-font.test.ts` checks.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

import { cardText } from '../../../examples/store/app/seo.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

export const FONT_FILE = path.join(ROOT, 'examples/store/app/og/noto-sans-jp.otf');
export const FONT_RECORD = path.join(HERE, 'font.json');
export const OFL_FILE = path.join(HERE, 'OFL.txt');

/** The characters in each inclusive code point range, in order. */
const ranges = (/** @type {readonly (readonly [number, number])[]} */ spans) =>
  spans.flatMap(([from, to]) =>
    Array.from({ length: to - from + 1 }, (_, index) => String.fromCodePoint(from + index)),
  );

/**
 * JIS X 0208 level-1 kanji (2,965), decoded from the Shift_JIS level-1 byte range 0x889F–0x9872:
 * lead bytes 0x88–0x98, trail bytes 0x40–0xFC except 0x7F, unassigned codes skipped.
 */
function level1Kanji() {
  const decoder = new TextDecoder('shift_jis', { fatal: true });
  const kanji = [];
  for (let lead = 0x88; lead <= 0x98; lead += 1) {
    for (let trail = 0x40; trail <= 0xfc; trail += 1) {
      const code = (lead << 8) | trail;
      if (trail === 0x7f || code < 0x889f || code > 0x9872) continue;
      try {
        kanji.push(decoder.decode(new Uint8Array([lead, trail])));
      } catch {
        // an unassigned code at the end of a row
      }
    }
  }
  return kanji;
}

/**
 * The broad set the font always holds, whatever the catalog says, so a new entry or headline
 * rarely needs a new subset: printable ASCII, Latin-1 punctuation and signs, the dashes, quotes,
 * ellipsis and arrows Japanese copy uses, CJK symbols and punctuation, every hiragana and katakana
 * (small and voiced forms, the prolonged sound mark, the middle dot), full-width ASCII and
 * JIS X 0208 level-1 kanji.
 */
export const BROAD_CHARS = [
  ...ranges([
    [0x20, 0x7e], // printable ASCII
    [0xa0, 0xbf], // Latin-1 punctuation and signs
    [0xd7, 0xd7], // ×
    [0xf7, 0xf7], // ÷
    [0x2010, 0x2016], // hyphens, dashes, double vertical line
    [0x2018, 0x2019], // ‘ ’
    [0x201c, 0x201d], // “ ”
    [0x2020, 0x2022], // † ‡ •
    [0x2025, 0x2026], // ‥ …
    [0x203b, 0x203b], // ※
    [0x2190, 0x2193], // ← ↑ → ↓
    [0x3000, 0x303f], // CJK symbols and punctuation
    [0x3041, 0x3096], // hiragana
    [0x3099, 0x309f], // voicing marks and hiragana iteration marks
    [0x30a0, 0x30ff], // katakana, the middle dot and the prolonged sound mark
    [0xff01, 0xff5e], // full-width ASCII
  ]),
  ...level1Kanji(),
];

/**
 * The characters the font holds: the broad set and every character the cards draw, sorted and
 * once each.
 *
 * @param {readonly import('../../../examples/store/catalog/define.ts').CatalogEntry[]} catalog
 */
export function fontChars(catalog) {
  return [...new Set([...BROAD_CHARS, ...cardChars(catalog)])].sort().join('');
}

/**
 * Every character the cards draw, sorted and once each.
 *
 * @param {readonly import('../../../examples/store/catalog/define.ts').CatalogEntry[]} catalog
 */
export function cardChars(catalog) {
  const text = catalog.flatMap((entry) => [cardText(entry, 'ja'), cardText(entry, 'en')]).join('');
  return [...new Set(text)].sort().join('');
}

/**
 * The record of a font: its sha256 and the characters it was cut to.
 *
 * @param {Uint8Array} bytes
 * @param {string} chars
 */
export function fontRecord(bytes, chars) {
  return { sha256: createHash('sha256').update(bytes).digest('hex'), chars };
}
