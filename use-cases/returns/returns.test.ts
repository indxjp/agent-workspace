/**
 * The returns use case (archetype RV): the contract, moment and flow tiers from the kit, and a check
 * that the typed output its eval runs ask for has one verdict per policy item (OK, caution or NG)
 * with the policy item (RET-01 to RET-05) it rests on, and no field that decides the refund.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/returns.ts';
import surface from './surfaces/main.ts';

describeUseCase('returns', {
  definitions: { 'agents/returns.ts': agent, 'surfaces/main.ts': surface },
});

describe('returns typed output', () => {
  it('asks for one verdict per policy item, and has no field that decides the refund', async () => {
    const text = await readFile(new URL('evals/returns.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/returns.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        required: ['request', 'orderNumber', 'items'],
        properties: {
          items: {
            items: {
              required: ['item', 'verdict', 'finding', 'toConfirm', 'standard'],
              properties: {
                verdict: { enum: ['ok', 'caution', 'ng'] },
                standard: { pattern: '^RET-0[1-5]$' },
              },
            },
          },
        },
      });
      expect(JSON.stringify(schema)).not.toMatch(/refund|amount|decision|approved/iu);
    }
  });
});
