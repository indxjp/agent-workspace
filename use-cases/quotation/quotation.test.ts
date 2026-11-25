/**
 * The quotation use case (archetype DR, the rebuild of the gallery's quotation agent): the contract,
 * moment and flow tiers of the kit. The flow runs the cost script the way `run_skill_script` does on
 * the sample rate tables, so every amount the quote states comes from tested code: the two demo
 * parts in Japanese and English, and the refusals of a thickness the table has no rate for, a
 * dimension that is not a number and a quantity that is not whole pieces. The ERP registration is
 * the one call that waits for a person.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { runScript } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import { needsApproval } from '@indx-workspace/contracts/agents';
import { readEvalCaseFile } from '@indx-workspace/sdk/project';
import { toAgentVersionBody } from '@indx-workspace/sdk/define';
import { describe, expect, it } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/quotation.ts';
import { compute, SPEC } from './skills/quotation/scripts/estimate.mjs';
import surface from './surfaces/main.ts';

const RATES = { ja: 'ERP_単価表.csv', en: 'erp-rates.csv' } as const;

/** What `estimate.mjs <rates> <material> <options>` prints, and its exit code. */
function estimate(lang: 'ja' | 'en', material: string, options: Record<string, string>) {
  const rates = fileURLToPath(new URL(`data/${lang}/${RATES[lang]}`, import.meta.url));
  const args = [
    rates,
    material,
    ...Object.entries(options).flatMap(([key, value]) => [`--${key}`, value]),
  ];
  const out: string[] = [];
  const err: string[] = [];
  const code = runScript(args, SPEC, compute, {
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
  });
  return { code, printed: JSON.parse(code === 0 ? out.join('') : err.join('')) as unknown };
}

// The two demo parts: the L bracket of the first prompt and the heat-sink plate of the second.
const BRACKET = {
  length: '200',
  width: '100',
  thickness: '3.2',
  holes: '4',
  diameter: '10',
  bends: '2',
  quantity: '50',
};
const PLATE = {
  length: '120',
  width: '80',
  thickness: '5',
  holes: '4',
  diameter: '5.5',
  bends: '0',
  quantity: '7',
};

describeUseCase('quotation', {
  definitions: { 'agents/quotation.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'prices the two demo parts from the rate table, the same in Japanese and English',
      run: () => {
        for (const lang of ['ja', 'en'] as const) {
          expect(estimate(lang, 'SS400', BRACKET)).toEqual({
            code: 0,
            printed: {
              material: 'SS400',
              quantity: 50,
              breakdown: { material: 94, cutting: 58, bending: 80, setup: 120 },
              cost: 352,
              unitPrice: 440,
              total: 22_000,
            },
          });
          expect(estimate(lang, 'A5052', PLATE)).toEqual({
            code: 0,
            printed: {
              material: 'A5052',
              quantity: 7,
              breakdown: { material: 145, cutting: 47, bending: 0, setup: 715 },
              cost: 907,
              unitPrice: 1180,
              total: 8260,
            },
          });
        }
        // The thinnest band the part fits under: t2.0 SUS304 is cut at the t3 rate (110 yen/m).
        expect(
          estimate('ja', 'SUS304', { ...BRACKET, thickness: '2', bends: '4', quantity: '30' }),
        ).toMatchObject({ printed: { breakdown: { cutting: 80, bending: 240, setup: 300 } } });
      },
    },
    {
      name: 'refuses a part it has no rate for and a dimension it cannot read, never guessing',
      run: () => {
        expect(estimate('ja', 'A5052', { ...PLATE, thickness: '8' })).toEqual({
          code: 1,
          printed: { error: 'no_rate', message: 'no A5052 rate for t8' },
        });
        expect(estimate('ja', 'SPCC', BRACKET).printed).toMatchObject({ error: 'no_rate' });
        expect(estimate('en', 'SS400', { ...BRACKET, width: '10cm' })).toEqual({
          code: 2,
          printed: { error: 'usage', message: '--width "10cm" is not a valid width' },
        });
        const noBends = Object.fromEntries(
          Object.entries(BRACKET).filter(([key]) => key !== 'bends'),
        );
        expect(estimate('en', 'SS400', noBends).printed).toEqual({
          error: 'usage',
          message: '--bends "" is not a valid bends',
        });
        expect(estimate('ja', 'SS400', { ...BRACKET, quantity: '0' }).printed).toEqual({
          error: 'usage',
          message: '--quantity "0" is not a valid quantity',
        });
        expect(estimate('ja', 'SS400', { ...BRACKET, quantity: '2.5' }).printed).toMatchObject({
          error: 'usage',
        });
      },
    },
  ],
});

describe('quotation approval', () => {
  it('waits for a person before the ERP registration, and reads and prices unasked', () => {
    const { policy } = toAgentVersionBody(agent, { instructions: '-' }).definition;
    const rules = 'requireApproval' in policy ? (policy.requireApproval ?? []) : [];
    expect(needsApproval(rules, 'mcp__quotation-erp__create_quote')).toBe(true);
    expect(needsApproval(rules, 'mcp__agent-workspace__run_skill_script')).toBe(false);
    expect(agent.permissions).toEqual({ readFiles: true, runCommands: true });
  });

  it('asks its typed eval runs for the quote with the breakdown and the orders it rests on', async () => {
    const text = await readFile(new URL('evals/quotation.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/quotation.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        required: ['drawingNo', 'unitPrice', 'total', 'breakdown', 'similarOrders'],
        properties: { similarOrders: { items: { pattern: '^SO-[0-9]{4}-[0-9]{4}$' } } },
      });
    }
  });
});
