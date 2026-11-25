/**
 * The summarizer use case (archetype DR): the contract, moment and flow tiers from the kit; a check
 * that its one write, the summary rendered by `office-writer`, waits for a person while reading
 * runs unasked; and a check that the eval cases asking for typed output ask for the outline, every
 * point with the sections it rests on, and no field for an opinion on the plan.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/summarizer.ts';
import surface from './surfaces/main.ts';

describeUseCase('summarizer', {
  definitions: { 'agents/summarizer.ts': agent, 'surfaces/main.ts': surface },
});

describe('summarizer approval', () => {
  it('renders the summary only after approval, and reads without asking', () => {
    expect((agent.skills ?? []).map((skill) => skill.name)).toContain('office-writer');
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
    expect(agent.files).toEqual([expect.objectContaining({ path: 'summarizer', access: 'read' })]);
  });
});

describe('summarizer typed output', () => {
  it('asks its typed eval runs for the outline, every point with its sources', async () => {
    const text = await readFile(new URL('evals/summarizer.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/summarizer.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        required: ['title', 'report', 'sections', 'openPoints'],
        additionalProperties: false,
        properties: {
          sections: {
            items: { properties: { points: { items: { required: ['text', 'sources'] } } } },
          },
        },
      });
      expect(JSON.stringify(schema)).not.toMatch(/"(opinion|advice|recommendation)"/);
    }
  });
});
