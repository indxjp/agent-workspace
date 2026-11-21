/**
 * The invoice use case (archetype RV): the contract, moment and flow tiers from the kit, and a
 * check that the eval cases asking for typed output ask for one verdict per line (OK, caution or
 * NG) with its fix and the matching rule (MATCH-01 to MATCH-04) it rests on.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/invoice.ts';
import surface from './surfaces/main.ts';

describeUseCase('invoice', {
  definitions: { 'agents/invoice.ts': agent, 'surfaces/main.ts': surface },
});

describe('invoice typed output', () => {
  it('asks its typed eval runs for one verdict per line, with the fix and the standard', async () => {
    const text = await readFile(new URL('evals/invoice.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/invoice.yaml').cases.flatMap((evalCase) =>
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
                standard: { pattern: '^MATCH-0[1-4]$' },
              },
            },
          },
        },
      });
    }
  });
});
