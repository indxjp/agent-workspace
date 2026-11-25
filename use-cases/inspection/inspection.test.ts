/**
 * The inspection use case (archetype RV): the contract, moment and flow tiers from the kit, and a
 * check that the eval cases asking for typed output ask for one verdict per item (OK, caution or
 * NG) with its fix and the item of the inspection standard (INS-01 to INS-06) it rests on.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/inspection.ts';
import surface from './surfaces/main.ts';

describeUseCase('inspection', {
  definitions: { 'agents/inspection.ts': agent, 'surfaces/main.ts': surface },
});

describe('inspection typed output', () => {
  it('asks its typed eval runs for one verdict per item, with the fix and the standard', async () => {
    const text = await readFile(new URL('evals/inspection.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/inspection.yaml').cases.flatMap((evalCase) =>
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
                standard: { pattern: '^INS-0[1-6]$' },
              },
            },
          },
        },
      });
    }
  });
});
