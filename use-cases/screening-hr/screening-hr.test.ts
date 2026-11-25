/**
 * The screening-hr use case (archetype RV): the contract, moment and flow tiers from the kit, and a
 * check that the typed output its eval runs ask for has one verdict per requirement (met, unclear
 * or not shown) with the evidence, and no field in which a person could be ranked, scored,
 * recommended or rejected (the plan's rule that a person decides about people).
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/screening-hr.ts';
import surface from './surfaces/main.ts';

describeUseCase('screening-hr', {
  definitions: { 'agents/screening-hr.ts': agent, 'surfaces/main.ts': surface },
});

describe('screening-hr typed output', () => {
  it('asks for one verdict per requirement with evidence, and has no field to rank a person', async () => {
    const text = await readFile(new URL('evals/screening-hr.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/screening-hr.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        required: ['application', 'items'],
        additionalProperties: false,
        properties: {
          items: {
            items: {
              required: ['requirement', 'verdict', 'evidence', 'reason', 'toConfirm'],
              additionalProperties: false,
              properties: {
                verdict: { enum: ['met', 'unclear', 'not_shown'] },
                requirement: { pattern: '^REQ-0[1-5]$' },
              },
            },
          },
        },
      });
      expect(JSON.stringify(schema)).not.toMatch(
        /score|rank|rating|grade|recommend|reject|pass|hire/iu,
      );
    }
  });
});
