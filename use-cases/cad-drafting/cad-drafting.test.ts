/**
 * The cad-drafting use case (archetype DR, the rebuild of the gallery's drawing agent): the
 * contract, moment and flow tiers of the kit. The flows run the draft script the way
 * `run_skill_script` does and read the DXF it writes back with the built-in DXF reader, so the
 * drawing and every refusal come from tested code: the demo's BRK-1101 (BRK-1003 with its height
 * changed and its holes moved) in Japanese and English, written on the layers the past drawings
 * use, and the refusals of a hole off the outline, a size that is not mm and an output that exists
 * already. The sample drawings are themselves read the same way, so the reuse rule the skill
 * states (four outline lines on a rectangle from the origin) holds for the ones it may reuse and
 * fails for the L-shaped BRK-1004. Its one write, the render, waits for a person.
 */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readDxf } from '@indx-workspace/builtin-skills/office-reader/scripts/dxf.mjs';
import { runScript } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import { describe, expect, it } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/cad-drafting.ts';
import { compute, SPEC } from './skills/cad-drafting/scripts/draft.mjs';
import surface from './surfaces/main.ts';

const OUT = mkdtempSync(path.join(tmpdir(), 'cad-drafting-'));

/** What `draft.mjs <out> <options>` prints, and its exit code. */
function draft(out: string, options: Record<string, string>) {
  const args = [path.join(OUT, out), ...Object.entries(options).flatMap(([k, v]) => [`--${k}`, v])];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runScript(args, SPEC, compute, {
    stdout: { write: (text: string) => stdout.push(text) },
    stderr: { write: (text: string) => stderr.push(text) },
  });
  return { code, printed: JSON.parse(code === 0 ? stdout.join('') : stderr.join('')) as unknown };
}

const DRAWINGS = fileURLToPath(new URL('data/', import.meta.url));
/** A sample drawing as the built-in reader reads it. */
const sample = (file: string) => readDxf(readFileSync(path.join(DRAWINGS, file)));

const BRK_1101 = {
  width: '140',
  height: '90',
  holes: '15,15,9;125,15,9;15,75,9;125,75,9',
};
const TITLE = {
  ja: '図番 BRK-1101;品名 ブラケット;材質 SUS304;板厚 t2.0;尺度 1:1;作成 2026-11-23 設計AI;検図 未;状態 未検図;派生元 BRK-1003',
  en: 'No. BRK-1101;Part Bracket;Material SUS304;Thickness t2.0;Scale 1:1;Drawn 2026-11-23 AI;Checked -;Status Unchecked;Derived BRK-1003',
} as const;
const NOTES = {
  ja: '注記1 指示なき角部は C0.5;注記2 バリ・カエリなきこと;注記3 表面処理 なし（2B仕上げ）',
  en: 'Note1 Unspecified corners C0.5;Note2 No burrs;Note3 Finish none (2B)',
} as const;
const PARTS = {
  ja: '部品表 1 BRK-1101 ブラケット SUS304 t2.0 1個',
  en: 'Parts 1 BRK-1101 Bracket SUS304 t2.0 x1',
};

describeUseCase('cad-drafting', {
  definitions: { 'agents/cad-drafting.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'writes BRK-1101 as a DXF the built-in reader reads, the same in Japanese and English',
      run: () => {
        for (const lang of ['ja', 'en'] as const) {
          const options = {
            ...BRK_1101,
            title: TITLE[lang],
            notes: NOTES[lang],
            parts: PARTS[lang],
          };
          expect(draft(`BRK-1101-${lang}.dxf`, options)).toEqual({
            code: 0,
            printed: {
              written: path.join(OUT, `BRK-1101-${lang}.dxf`),
              width: 140,
              height: 90,
              holes: [
                { x: 15, y: 15, diameter: 9 },
                { x: 125, y: 15, diameter: 9 },
                { x: 15, y: 75, diameter: 9 },
                { x: 125, y: 75, diameter: 9 },
              ],
              title: TITLE[lang].split(';'),
              notes: [...NOTES[lang].split(';'), PARTS[lang], '未検図'],
            },
          });
          const written = readDxf(readFileSync(path.join(OUT, `BRK-1101-${lang}.dxf`)));
          expect(written.counts).toEqual({ LINE: 4, CIRCLE: 4, TEXT: 9 + 3 + 1 + 1 });
          expect(written.layers).toEqual(['OUTLINE', 'HOLE', 'TITLE', 'NOTE']);
          expect(written.texts.map((text) => text.text)).toContain(TITLE[lang].split(';')[0]);
        }
        // Without holes, a title or notes it writes the outline and the draft note: nothing guessed.
        expect(draft('bare.dxf', { width: '120', height: '70' })).toMatchObject({
          code: 0,
          printed: { holes: [], title: [], notes: ['未検図'] },
        });
      },
    },
    {
      name: 'refuses a hole off the outline, a size that is not mm and an existing output',
      run: () => {
        const refusal = {
          error: 'not_inside',
          message: 'a size is not in mm, or a hole is not inside the outline',
        };
        expect(draft('off.dxf', { ...BRK_1101, holes: '15,15,9;137,15,9' })).toEqual({
          code: 1,
          printed: refusal,
        });
        expect(draft('off.dxf', { ...BRK_1101, holes: '15,15' }).printed).toEqual(refusal);
        expect(draft('off.dxf', { ...BRK_1101, width: '140mm' }).printed).toEqual(refusal);
        // The script keeps a draft a draft: a title that marks it checked or released is refused.
        const refused = {
          error: 'not_a_draft',
          message: 'a draft is never checked or released: 検図 未, 状態 未検図',
        };
        for (const field of [
          '状態 出図',
          '検図 2026-11-23 檜垣',
          'Status Released',
          'checked yes',
        ]) {
          expect(draft('released.dxf', { ...BRK_1101, title: `図番 BRK-1101;${field}` })).toEqual({
            code: 1,
            printed: refused,
          });
        }
        expect(draft('BRK-1101-ja.dxf', BRK_1101).printed).toEqual({
          error: 'output_exists',
          message: `${path.join(OUT, 'BRK-1101-ja.dxf')} exists already`,
        });
      },
    },
  ],
});

describe('cad-drafting sample drawings', () => {
  it('holds past drawings in both languages; BRK-1004 alone is not a rectangle from the origin', () => {
    for (const lang of ['ja', 'en']) {
      const files = readdirSync(path.join(DRAWINGS, lang), { recursive: true })
        .map(String)
        .filter((file) => file.endsWith('.dxf'))
        .sort();
      const reusable = files.filter((file) => {
        const outline = sample(path.join(lang, file)).lines.filter((l) => l.layer === 'OUTLINE');
        const corners = outline.flatMap((l) => [l.x1, l.y1, l.x2, l.y2]);
        return outline.length === 4 && corners.filter((v) => v === 0).length === 8;
      });
      expect(files).toHaveLength(6);
      expect(files.filter((file) => !reusable.includes(file))).toEqual([
        'drawings/BRK/BRK-1004.dxf',
      ]);
    }
    expect(sample('ja/drawings/BRK/BRK-1003.dxf').circles).toHaveLength(4);
  });
});

describe('cad-drafting approval', () => {
  it('writes the drawing only through the script a person approves, and searches unasked', () => {
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
    expect(agent.files).toEqual([
      expect.objectContaining({ path: 'cad-drafting', access: 'read' }),
    ]);
  });
});
