/**
 * The ir-qa use case (archetype DR): the contract, moment and flow tiers from the kit; a check that
 * its one write, the expected Q&A rendered by `office-writer`, waits for a person while reading runs
 * unasked; and a check that the eval cases asking for typed output ask for the outline, every
 * answer with the disclosed materials it rests on and no field for advice on the shares.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/ir-qa.ts';
import surface from './surfaces/main.ts';

describeUseCase('ir-qa', {
  definitions: { 'agents/ir-qa.ts': agent, 'surfaces/main.ts': surface },
});

describe('ir-qa approval', () => {
  it('renders the document only after approval, and reads without asking', () => {
    expect((agent.skills ?? []).map((skill) => skill.name)).toContain('office-writer');
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
    expect(agent.files).toEqual([expect.objectContaining({ path: 'ir-qa', access: 'read' })]);
  });
});

describe('ir-qa typed output', () => {
  it('asks for answers with their sources and no field for advice on the shares', async () => {
    const text = await readFile(new URL('evals/ir-qa.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/ir-qa.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        required: ['title', 'items', 'openPoints'],
        properties: { items: { items: { required: ['theme', 'question', 'answer', 'sources'] } } },
      });
      const fields = [...JSON.stringify(schema).matchAll(/"([A-Za-z]+)":/g)].map(
        ([, name]) => name,
      );
      for (const field of fields) {
        expect(field).not.toMatch(/^(rating|recommendation|target|targetPrice|buy|sell|hold)$/);
      }
    }
  });
});
