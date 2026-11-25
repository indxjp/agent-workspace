#!/usr/bin/env node
// The new drawing (DXF, unchecked), as `run_skill_script` runs it:
//
//   draft.mjs <out.dxf> --width <mm> --height <mm> --holes "<x>,<y>,<diameter>;…"
//             --title "<field> <value>;…" --notes "<note>;…" [--parts "<row>;…"]
//
// It writes an ASCII DXF (AutoCAD 2013, UTF-8) on the layers the past drawings use: the outline as
// a width × height rectangle from the origin (OUTLINE), each hole at (x, y) from the lower left
// corner (HOLE), the title block to the right (TITLE) and, under the outline, the notes, the parts
// list rows and a last note that the drawing is an unchecked draft (NOTE). It prints the drawing it
// wrote. A size that is not a number of mm, a hole that is not inside the outline and an output
// that exists already are refused on stderr: it never guesses and never overwrites.
import { existsSync, writeFileSync } from 'node:fs';

import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import { TableError } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

export const SPEC = {
  usage: 'draft.mjs <out.dxf> --width <mm> --height <mm> --holes <x,y,d;…> --title <…> --notes <…>',
  positionals: ['out'],
  options: { width: {}, height: {}, holes: {}, title: {}, notes: {}, parts: {} },
};
const LAYERS = ['OUTLINE', 'HOLE', 'TITLE', 'NOTE'].map(
  (name) => `0\nLAYER\n2\n${name}\n70\n0\n62\n7\n6\nCONTINUOUS`,
);
const HEAD = '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1027\n9\n$DWGCODEPAGE\n3\nUTF-8\n0\nENDSEC';
const TABLES = [
  '0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n4',
  ...LAYERS,
  '0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES',
];

// A title field that would mark the draft checked or released: 検図 and 状態 stay 未 and 未検図.
const RELEASED = /^(検図|状態|checked|status) (?!(未|未検図|-|unchecked)$)/iu;
const DRAFT = 'a draft is never checked or released: 検図 未, 状態 未検図';

/** @param {string | undefined} text */
const items = (text = '') => text.split(/\s*;\s*/u).filter(Boolean);
/** @param {string} layer @param {number} x @param {number} y @param {string} value */
const text = (layer, x, y, value) =>
  `0\nTEXT\n8\n${layer}\n10\n${x}\n20\n${y}\n40\n3.5\n1\n${value}`;
/** @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2 */
const line = (x1, y1, x2, y2) => `0\nLINE\n8\nOUTLINE\n10\n${x1}\n20\n${y1}\n11\n${x2}\n21\n${y2}`;

/** @param {import('@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs').ParsedArgs} args */
export function compute({ positionals, options }) {
  const out = String(positionals['out']);
  const [width, height] = [Number(options['width']), Number(options['height'])];
  const holes = items(options['holes']).map((hole) => {
    const [x, y, diameter] = /** @type {[number, number, number]} */ (hole.split(',').map(Number));
    return { x, y, diameter };
  });
  /** @param {{ x: number, y: number, diameter: number }} hole */
  const fits = ({ x, y, diameter: d }) => d < 2 * Math.min(x, y, width - x, height - y);
  if (!(width > 0 && height > 0 && holes.every(fits)))
    throw new TableError('not_inside', 'a size is not in mm, or a hole is not inside the outline');
  if (existsSync(out)) throw new TableError('output_exists', `${out} exists already`);
  const title = items(options['title']);
  if (title.some((field) => RELEASED.test(field))) throw new TableError('not_a_draft', DRAFT);
  const notes = [...items(options['notes']), ...items(options['parts']), '未検図'];
  const entities = [
    line(0, 0, width, 0),
    line(width, 0, width, height),
    line(width, height, 0, height),
    line(0, height, 0, 0),
    ...holes.map(({ x, y, diameter: d }) => `0\nCIRCLE\n8\nHOLE\n10\n${x}\n20\n${y}\n40\n${d / 2}`),
    ...title.map((value, i) => text('TITLE', width + 30, height - 7 * i, value)),
    ...notes.map((value, i) => text('NOTE', 0, -15 - 7 * i, value)),
  ];
  writeFileSync(out, `${[HEAD, ...TABLES, ...entities, '0\nENDSEC\n0\nEOF'].join('\n')}\n`);
  return { written: out, width, height, holes, title, notes };
}

runWhenMain(import.meta.url, SPEC, compute);
