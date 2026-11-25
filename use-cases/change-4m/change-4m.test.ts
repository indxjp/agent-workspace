/**
 * The change-4m use case (archetype RV): the contract, moment and flow tiers from the kit, and a
 * check that the eval cases asking for typed output ask for one verdict per rule (OK, caution or NG) with its action and the change control rule (CHG-01 to CHG-05) it rests on.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import change4m from './agents/change-4m.ts';
import surface from './surfaces/main.ts';

describeUseCase('change-4m', {
  definitions: { 'agents/change-4m.ts': change4m, 'surfaces/main.ts': surface },
});

describe('change-4m typed output', () => {
  it('asks its typed eval runs for one verdict per item, with the fix and the rule', async () => {
    const text = await readFile(new URL('evals/change-4m.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/change-4m.yaml').cases.flatMap((evalCase) =>
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
                standard: { pattern: '^CHG-0[1-5]$' },
              },
            },
          },
        },
      });
    }
  });
});
