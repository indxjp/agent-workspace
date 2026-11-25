/**
 * The ringi-review use case (archetype RV, the rebuild of the gallery's ringi review): the contract,
 * moment and flow tiers from the kit. The flow runs the route script the way `run_skill_script` does
 * on the sample schedules, so every route the agent reports comes from tested code: the three sample
 * ringi in Japanese and English, and the refusals of an unknown category and an amount that is not
 * whole yen. Its typed eval asks for one verdict per check with the rule it rests on.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { runScript } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import { readEvalCaseFile } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/ringi-review.ts';
import { compute, SPEC } from './skills/ringi-review/scripts/route.mjs';
import surface from './surfaces/main.ts';

const matrix = (lang: 'ja' | 'en'): string =>
  fileURLToPath(new URL(`data/${lang}/standards/authority-matrix.csv`, import.meta.url));

/** What `route.mjs <matrix> <category> <amount>` prints, and its exit code. */
function route(lang: 'ja' | 'en', category: string, amount: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
  };
  const code = runScript([matrix(lang), category, amount], SPEC, compute, io);
  return {
    code,
    printed:
      out.join('') === ''
        ? (JSON.parse(err.join('')) as unknown)
        : (JSON.parse(out.join('')) as unknown),
  };
}

describeUseCase('ringi-review', {
  definitions: { 'agents/ringi-review.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'routes the three sample ringi by the schedule, the same in Japanese and English',
      run: () => {
        expect(route('ja', '設備投資', '45000000')).toEqual({
          code: 0,
          printed: {
            category: '設備投資',
            amountYen: 45_000_000,
            approver: '取締役会',
            coReview: null,
            clause: '職務権限規程 別表 §3.1',
            standard: 'GR-003 §3.1',
          },
        });
        expect(route('ja', '寄付', '100000').printed).toMatchObject({
          approver: '社長',
          coReview: '総務部長',
          clause: '職務権限規程 別表 §3.4',
          standard: 'GR-003 §3.4',
        });
        expect(route('ja', '業務委託', '12000000').printed).toMatchObject({ approver: '本部長' });
        expect(route('en', 'capital investment', '45000000').printed).toMatchObject({
          approver: 'Board of Directors',
        });
        expect(route('en', 'donation', '100000').printed).toMatchObject({
          standard: 'GR-003 §3.4',
          approver: 'President',
          coReview: 'Head of General Affairs',
        });
        expect(route('en', 'outsourcing', '12000000').printed).toMatchObject({
          approver: 'Division Head',
        });
        // A limit is inclusive: exactly 3,000,000 yen of capital investment is a department head's.
        expect(route('ja', '設備投資', '3000000').printed).toMatchObject({ approver: '部長' });
      },
    },
    {
      name: 'reads the amount as a ringi writes it: separators, the yen sign or word, full-width digits',
      run: () => {
        for (const written of [
          '45,000,000',
          '45,000,000円',
          '¥45,000,000',
          '￥45,000,000',
          '45000000 yen',
          '45,000,000 Yen',
          '４５，０００，０００円',
        ]) {
          expect(route('ja', '設備投資', written).printed, written).toMatchObject({
            amountYen: 45_000_000,
            approver: '取締役会',
          });
        }
      },
    },
    {
      name: 'refuses an unknown category and an amount that is not whole yen, never guessing',
      run: () => {
        expect(route('ja', '雑費', '1000')).toEqual({
          code: 1,
          printed: { error: 'no_route', message: 'the schedule has no row for 雑費' },
        });
        for (const amount of ['4,500万円', '45000000.5', '-45000000', '']) {
          expect(route('ja', '設備投資', amount)).toEqual({
            code: 2,
            printed: { error: 'usage', message: `"${amount}" is not whole yen` },
          });
        }
      },
    },
  ],
});

describe('ringi-review typed output', () => {
  it('asks its typed eval runs for one verdict per check, with the rule code and section', async () => {
    const text = await readFile(new URL('evals/ringi-review.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/ringi-review.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        required: ['document', 'items'],
        properties: {
          items: {
            items: {
              required: ['item', 'verdict', 'finding', 'fix', 'standard'],
              properties: {
                verdict: { enum: ['ok', 'caution', 'ng'] },
                standard: { pattern: '^GR-0(02|03|11) §[0-9]+\\.[0-9]+$' },
              },
            },
          },
        },
      });
    }
  });
});
