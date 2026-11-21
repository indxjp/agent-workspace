/**
 * The glossary use case (archetype RV): the contract and moment tiers from the kit, and a check
 * that the eval cases asking for typed output ask for one verdict per glossary term (OK, caution or
 * NG) with its fix and the glossary row (TERM-01 to TERM-08) it rests on.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/glossary.ts';
import surface from './surfaces/main.ts';

describeUseCase('glossary', {
  definitions: { 'agents/glossary.ts': agent, 'surfaces/main.ts': surface },
});

describe('glossary typed output', () => {
  it('asks its typed eval runs for one verdict per term, with the fix and the row', async () => {
    const text = await readFile(new URL('evals/glossary.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/glossary.yaml').cases.flatMap((evalCase) =>
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
                standard: { pattern: '^TERM-0[1-8]$' },
              },
            },
          },
        },
      });
    }
  });
});
