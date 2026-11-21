/**
 * The social cards' font (use-cases plan §6.3): a Noto Sans JP subset committed beside the card
 * route, drawn with at build time, so a card never fetches a font. It holds a broad, stable set
 * (ASCII, Japanese punctuation, every kana, full-width ASCII, JIS X 0208 level-1 kanji) and every
 * character a card draws, so a new entry needs a new subset only when its card draws a character
 * outside that set. `font.json` records the characters `subset.mjs` cut it to, and the font's
 * sha256 ties the record to the committed file. The SIL Open Font License travels with it.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CATALOG } from '../../examples/store/catalog/index.ts';
import {
  BROAD_CHARS,
  cardChars,
  FONT_FILE,
  FONT_RECORD,
  fontRecord,
  OFL_FILE,
} from './og-font/font.mjs';

const REGENERATE = 'python3 -m pip install fonttools && node tests/store/og-font/subset.mjs';

const record = JSON.parse(readFileSync(FONT_RECORD, 'utf8')) as { sha256: string; chars: string };

describe('the social cards font', () => {
  it('is the font font.json records', () => {
    expect(fontRecord(readFileSync(FONT_FILE), record.chars)).toStrictEqual(record);
  });

  it(`holds every character a card draws (missing: run ${REGENERATE})`, () => {
    const held = new Set(record.chars);
    const missing = [...cardChars(CATALOG)].filter((char) => !held.has(char));
    expect(missing.join('')).toBe('');
  });

  it(`holds the broad set, whatever the catalog draws (missing: run ${REGENERATE})`, () => {
    const held = new Set(record.chars);
    expect(BROAD_CHARS.filter((char) => !held.has(char)).join('')).toBe('');
  });

  it('the broad set holds every kana and the 2,965 level-1 kanji', () => {
    expect(BROAD_CHARS).toEqual(expect.arrayContaining([...'ぁゔゕゝゞァヴヵヶ・ーヽヾ亜腕']));
    expect(BROAD_CHARS.filter((char) => /[\u4E00-\u9FFF]/u.test(char))).toHaveLength(2965);
  });

  it('comes with the SIL Open Font License', () => {
    const licence = readFileSync(OFL_FILE, 'utf8');
    expect(licence).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(licence).toContain('Copyright © 2014-2021 Adobe');
  });
});
