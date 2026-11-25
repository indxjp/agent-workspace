/**
 * The excel-consolidation use case (archetype AN, the rebuild of the gallery's Excel consolidation):
 * the contract, moment and flow tiers of the kit. The flows run the script the way
 * `run_skill_script` does on the sample branch workbooks, five layouts per language, so every unit,
 * skipped row, left-out file, total and change the answer reports comes from tested code, the same
 * in Japanese and English, and the office-writer model it writes holds exactly those rows. Its
 * writes, the consolidation and the render, wait for a person.
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScript } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import { describe, expect, it } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/excel-consolidation.ts';
import { compute, SPEC } from './skills/excel-consolidation/scripts/analyse.mjs';
import surface from './surfaces/main.ts';

const DATA = (lang: 'ja' | 'en'): string => fileURLToPath(new URL(`data/${lang}`, import.meta.url));
const OUT = mkdtempSync(path.join(tmpdir(), 'excel-consolidation-'));

/** What `analyse.mjs <folder> <options>` prints, and its exit code. */
function analyse(folder: string, options: Record<string, string>) {
  const args = [folder, ...Object.entries(options).flatMap(([key, value]) => [`--${key}`, value])];
  const out: string[] = [];
  const err: string[] = [];
  const code = runScript(args, SPEC, compute, {
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
  });
  return {
    code,
    printed: JSON.parse(code === 0 ? out.join('') : err.join('')) as Record<string, unknown>,
  };
}

const MAY = { from: '2025-04', to: '2025-05' };
// The branches, largest change first, in yen: [April, May, change, change %].
const FIGURES = [
  [2_825_000, 3_365_000, 540_000, 19.1],
  [870_000, 1_140_000, 270_000, 31],
  [1_165_000, 933_000, -232_000, -19.9],
  [550_000, 505_000, -45_000, -8.2],
  [602_000, 633_000, 31_000, 5.1],
];
const BRANCHES = {
  ja: ['東京支店', '名古屋営業所', '大阪支店', '札幌営業所', '福岡支店'],
  en: ['Tokyo', 'Nagoya', 'Osaka', 'Sapporo', 'Fukuoka'],
} as const;

describeUseCase('excel-consolidation', {
  definitions: { 'agents/excel-consolidation.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'consolidates five layouts into one table, the same in Japanese and English',
      run: () => {
        for (const lang of ['ja', 'en'] as const) {
          const book = path.join(OUT, `consolidated-${lang}.json`);
          const { code, printed } = analyse(DATA(lang), { ...MAY, book });
          expect(code).toBe(0);
          const branches = printed['branches'] as {
            branch: string;
            from: number;
            to: number;
            change: number;
            changePct: number;
          }[];
          expect(branches.map((b) => [b.branch, b.from, b.to, b.change, b.changePct])).toEqual(
            BRANCHES[lang].map((branch, at) => [branch, ...(FIGURES[at] ?? [])]),
          );
          expect(printed['total']).toEqual({
            from: 6_012_000,
            to: 6_576_000,
            change: 564_000,
            changePct: 9.4,
          });
          const layouts = printed['layouts'] as {
            branch: string;
            unit: string;
            skipped: unknown[];
          }[];
          expect(layouts).toHaveLength(10);
          expect(Object.fromEntries(layouts.map((l) => [l.branch, l.unit]))).toEqual(
            Object.fromEntries(
              BRANCHES[lang].map((b) => [
                b,
                ['東京支店', '名古屋営業所', '札幌営業所', 'Tokyo', 'Nagoya', 'Sapporo'].includes(b)
                  ? '千円'
                  : '円',
              ]),
            ),
          );
          // The subtotal, total and note rows are named, never counted: two per Tokyo, Osaka and Fukuoka workbook pair.
          expect(layouts.flatMap((l) => l.skipped)).toHaveLength(6);
          expect((printed['excluded'] as { reason: string }[]).map((e) => e.reason).sort()).toEqual(
            ['no date, category and amount columns', 'no rows'],
          );
          const model = JSON.parse(readFileSync(book, 'utf8')) as {
            format: string;
            sheets: { name: string; rows: unknown[][] }[];
          };
          expect(model.format).toBe('xlsx');
          expect(model.sheets.map((sheet) => [sheet.name, sheet.rows.length])).toEqual([
            ['Detail', 27],
            ['Comparison', 6],
          ]);
          expect(model.sheets[1]?.rows.at(-1)).toEqual([
            '合計 / Total',
            6_012_000,
            6_576_000,
            564_000,
            9.4,
          ]);
          expect(printed['book']).toBe(book);
          // Each branch names the categories behind its change, largest first, so the explanation
          // rests on printed figures.
          const tokyo = branches[0] as unknown as { categories: { change: number }[] };
          expect(tokyo.categories.map((c) => c.change)).toEqual([500_000, 25_000, 15_000]);
          const osaka = branches[2] as unknown as { categories: { change: number }[] };
          expect(osaka.categories.map((c) => c.change)).toEqual([-220_000, -7_000, -5_000]);
          // A model file that exists already is never overwritten.
          expect(analyse(DATA(lang), { ...MAY, book }).printed).toEqual({
            error: 'output_exists',
            message: `${book} exists already`,
          });
        }
      },
    },
    {
      name: 'compares any two months, writes no model unless asked, and refuses what it cannot read',
      run: () => {
        // A month with no rows counts as 0, and a change from 0 has no percentage.
        const { printed } = analyse(DATA('ja'), { from: '2025-03', to: '2025-04' });
        expect(printed).toMatchObject({
          book: null,
          total: { from: 0, to: 6_012_000, changePct: null },
        });
        expect(analyse(DATA('ja'), { from: '2025/04', to: '2025-05' })).toEqual({
          code: 2,
          printed: { error: 'usage', message: '--from and --to are YYYY-MM' },
        });
        const folder = path.join(OUT, 'broken', '本社');
        mkdirSync(folder, { recursive: true });
        writeFileSync(path.join(folder, 'broken.xlsx'), 'not a workbook');
        expect(analyse(path.join(OUT, 'broken'), MAY).code).toBe(1);
      },
    },
  ],
});

describe('excel-consolidation approval', () => {
  it('runs the consolidation and the render only after a person approves, and searches unasked', () => {
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
    expect((agent.skills ?? []).map((s) => s.name)).toEqual([
      'office-reader',
      'office-writer',
      'excel-consolidation',
    ]);
    expect(agent.files).toEqual([
      expect.objectContaining({ path: 'excel-consolidation', access: 'read' }),
    ]);
  });
});
