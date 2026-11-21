/**
 * The ad-compliance use case (archetype RV): the contract, moment and flow tiers from the kit, and a
 * check that the eval cases asking for typed output ask for one verdict per claim (OK, caution or
 * NG) with its fix and the item of the company's advertising standard (AD-01 to AD-06) it rests on.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/ad-compliance.ts';
import surface from './surfaces/main.ts';

describeUseCase('ad-compliance', {
  definitions: { 'agents/ad-compliance.ts': agent, 'surfaces/main.ts': surface },
});

describe('ad-compliance typed output', () => {
  it('asks its typed eval runs for one verdict per claim, with the fix and the standard', async () => {
    const text = await readFile(new URL('evals/ad-compliance.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/ad-compliance.yaml').cases.flatMap((evalCase) =>
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
                standard: { pattern: '^AD-0[1-6]$' },
              },
            },
          },
        },
      });
    }
  });
});
