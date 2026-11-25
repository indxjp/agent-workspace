#!/usr/bin/env node
/* global console */
/**
 * Writes the social cards' font, `examples/store/app/og/noto-sans-jp.otf`: Noto Sans CJK JP Regular
 * cut down to a broad, stable set (`BROAD_CHARS` in `font.mjs`: ASCII, Japanese punctuation, every
 * kana, full-width ASCII and JIS X 0208 level-1 kanji) plus every character the cards draw (every
 * entry's name and headline, both languages). Run it only when a card draws a character outside
 * the broad set: `tests/store/og-font.test.ts` names it. The full SIL Open Font License goes into the font's own name table (ID 13), and
 * `OFL.txt` beside this script holds it as a file. `font.json` records the font's sha256 and its
 * characters, which `tests/store/og-font.test.ts` checks against the catalog, so a card never needs
 * a glyph the font lacks (and `next/og` never fetches one).
 *
 *   python3 -m pip install fonttools
 *   node tests/store/og-font/subset.mjs
 *
 * `NOTO_SANS_CJK` names the source collection (default: Debian's fonts-noto-cjk
 * `NotoSansCJK-Regular.ttc`, whose first face is JP) and `FONTTOOLS_PYTHON` the Python with
 * fontTools (default `python3`).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import { CATALOG } from '../../../examples/store/catalog/index.ts';
import { FONT_FILE, FONT_RECORD, fontChars, fontRecord, OFL_FILE } from './font.mjs';

const SOURCE =
  process.env['NOTO_SANS_CJK'] ?? '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';
const PYTHON = process.env['FONTTOOLS_PYTHON'] ?? 'python3';

/**
 * Subsets face 0 of `argv[1]` to the characters `argv[2]` (failing if the face lacks any), sets
 * name ID 13 to `argv[3]`, writes `argv[4]`.
 */
const SUBSET = `
import sys
from fontTools import subset
from fontTools.ttLib import TTFont
font = TTFont(sys.argv[1], fontNumber=0)
cmap = font.getBestCmap()
missing = ''.join(char for char in sys.argv[2] if ord(char) >= 0x20 and ord(char) not in cmap)
if missing:
    sys.exit('the source font lacks: ' + missing)
options = subset.Options()
options.name_IDs = ['*']
options.name_languages = ['*']
subsetter = subset.Subsetter(options)
subsetter.populate(text=sys.argv[2])
subsetter.subset(font)
for record in font['name'].names:
    if record.nameID == 13:
        record.string = sys.argv[3]
font.save(sys.argv[4])
`;

const chars = fontChars(CATALOG);
const result = spawnSync(
  PYTHON,
  ['-I', '-c', SUBSET, SOURCE, chars, readFileSync(OFL_FILE, 'utf8'), FONT_FILE],
  { stdio: 'inherit' },
);
if (result.status !== 0) throw new Error(`the subset failed (${String(result.status)})`);
writeFileSync(
  FONT_RECORD,
  `${JSON.stringify(fontRecord(readFileSync(FONT_FILE), chars), null, 2)}\n`,
);
console.log(`wrote ${FONT_FILE} (${String([...chars].length)} characters)`);
