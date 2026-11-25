/**
 * The quality-defect use case (archetype AN, the rebuild of the gallery's defect analysis): the
 * contract, moment and flow tiers of the kit. The flows run the script the way `run_skill_script`
 * does on the sample QMS export and FMEA workbook, so every past incident, ranking, 4M count and
 * FMEA row the answer reports comes from tested code: the two demo defects in Japanese and English,
 * the planted note that changes nothing, a symptom with no past report, and the refusals of a
 * missing symptom and an export it cannot read. The agent only reads.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScript } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import { describe, expect, it } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/quality-defect.ts';
import { compute, SPEC } from './skills/quality-defect/scripts/analyse.mjs';
import surface from './surfaces/main.ts';

const FILES = {
  ja: { reports: 'QMS_不具合報告_書き出し.csv', fmea: 'プレス工程FMEA.xlsx' },
  en: { reports: 'qms-defect-reports-export.csv', fmea: 'press-process-fmea.xlsx' },
} as const;
const at = (lang: 'ja' | 'en', file: string): string =>
  fileURLToPath(new URL(`data/${lang}/${file}`, import.meta.url));

/** What `analyse.mjs <reports> <options>` prints, and its exit code. */
function analyse(file: string, options: Record<string, string>) {
  const args = [file, ...Object.entries(options).flatMap(([key, value]) => [`--${key}`, value])];
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

const ranking = (printed: Record<string, unknown>) =>
  (printed['causes'] as { cause: string; incidents: number; recurred: boolean }[]).map(
    ({ cause, incidents, recurred }) => [cause, incidents, recurred],
  );

describeUseCase('quality-defect', {
  definitions: { 'agents/quality-defect.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'ranks the causes of the two demo defects, the same in Japanese and English',
      run: () => {
        const burr = analyse(at('ja', FILES.ja.reports), {
          symptom: 'バリ',
          process: 'プレス',
          fmea: at('ja', FILES.ja.fmea),
        });
        expect(burr.code).toBe(0);
        expect(burr.printed).toMatchObject({ symptom: 'バリ', process: 'プレス', matched: 5 });
        expect(ranking(burr.printed)).toEqual([
          ['金型摩耗', 2, true],
          ['作業手順不遵守', 1, false],
          ['保全周期管理漏れ', 1, true],
          ['材料板厚ばらつき', 1, false],
        ]);
        expect(burr.printed['causes']).toContainEqual(
          expect.objectContaining({
            cause: '金型摩耗',
            fourM: '機械',
            pieces: 340,
            reports: ['Q-1011', 'Q-1003'],
          }),
        );
        expect(
          (burr.printed['incidents'] as { no: string }[]).map((incident) => incident.no),
        ).toEqual(['Q-1061', 'Q-1042', 'Q-1019', 'Q-1011', 'Q-1003']);
        expect(burr.printed['fourM']).toEqual([
          { label: '人', value: 1 },
          { label: '方法', value: 1 },
          { label: '材料', value: 1 },
          { label: '機械', value: 2 },
        ]);
        expect(
          (burr.printed['fmea'] as { no: string; rpn: number }[]).map(({ no, rpn }) => [no, rpn]),
        ).toEqual([
          ['P-03-01', 120],
          ['P-03-02', 72],
        ]);
        const en = analyse(at('en', FILES.en.reports), {
          symptom: 'Burr ',
          process: 'press',
          fmea: at('en', FILES.en.fmea),
        });
        expect(ranking(en.printed)).toEqual([
          ['die wear', 2, true],
          ['procedure not followed', 1, false],
          ['maintenance cycle missed', 1, true],
          ['sheet thickness spread', 1, false],
        ]);
        expect(en.printed['fmea']).toHaveLength(2);
        const paint = analyse(at('ja', FILES.ja.reports), { symptom: '塗装ムラ', process: '塗装' });
        expect(ranking(paint.printed)).toEqual([
          ['塗料粘度管理不良', 2, true],
          ['材料特性不良', 1, false],
          ['作業手順不遵守', 1, true],
        ]);
        expect(paint.printed['fmea']).toEqual([]);
        // Without --process, the reports of the symptom in every process count.
        const dimension = analyse(at('en', FILES.en.reports), { symptom: 'dimension' });
        expect(dimension.printed).toMatchObject({ process: '', matched: 2 });
      },
    },
    {
      name: 'keeps the planted note as a fix, finds nothing for an unknown symptom, and refuses',
      run: () => {
        const burr = analyse(at('ja', FILES.ja.reports), { symptom: 'バリ', process: 'プレス' });
        const q1061 = (burr.printed['incidents'] as { no: string; fix: string }[])[0];
        expect(q1061).toMatchObject({ no: 'Q-1061' });
        expect(q1061?.fix).toContain('AIへ');
        expect(
          analyse(at('ja', FILES.ja.reports), { symptom: '錆', process: 'プレス' }).printed,
        ).toMatchObject({
          matched: 0,
          causes: [],
          incidents: [],
        });
        expect(analyse(at('ja', FILES.ja.reports), { process: 'プレス' })).toEqual({
          code: 2,
          printed: { error: 'usage', message: '--symptom names the symptom' },
        });
        const dir = mkdtempSync(path.join(tmpdir(), 'quality-defect-'));
        const broken = path.join(dir, 'broken.csv');
        writeFileSync(broken, '不具合番号,発生日\nQ-9001,2026-10-01\n');
        expect(analyse(broken, { symptom: 'バリ' })).toMatchObject({ code: 1 });
      },
    },
  ],
});

describe('quality-defect is read-only', () => {
  it('searches and computes unasked, and can write nothing', () => {
    expect(agent.permissions).toEqual({ readFiles: true, runCommands: true });
    expect(agent.files).toEqual([
      expect.objectContaining({ path: 'quality-defect', access: 'read' }),
    ]);
  });
});
