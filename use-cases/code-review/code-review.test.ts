/**
 * The code-review use case (archetype RV): the contract, moment and flow tiers from the kit, and a
 * check that the typed output its eval runs ask for has one verdict per rule (OK, caution or NG) with
 * the line it rests on, the fix and the rule (CS-01 to CS-06), and no field that claims a test run.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/code-review.ts';
import surface from './surfaces/main.ts';

describeUseCase('code-review', {
  definitions: { 'agents/code-review.ts': agent, 'surfaces/main.ts': surface },
});

describe('code-review typed output', () => {
  it('asks for one verdict per rule with its line and fix, and has no field for a test run', async () => {
    const text = await readFile(new URL('evals/code-review.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/code-review.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        required: ['patch', 'items'],
        properties: {
          items: {
            items: {
              required: ['verdict', 'location', 'finding', 'fix', 'standard'],
              properties: {
                verdict: { enum: ['ok', 'caution', 'ng'] },
                standard: { pattern: '^CS-0[1-6]$' },
              },
            },
          },
        },
      });
      expect(JSON.stringify(schema)).not.toMatch(/passed|testResult|executed|approved/iu);
    }
  });
});
