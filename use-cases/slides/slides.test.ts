/**
 * The slides use case (archetype DR): the contract, moment and flow tiers from the kit; a check
 * that its one write, the deck rendered by `office-writer`, waits for a person while reading runs
 * unasked; and a check that the eval cases asking for typed output ask for the outline, every
 * slide with the ids of the files it rests on.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/slides.ts';
import surface from './surfaces/main.ts';

describeUseCase('slides', {
  definitions: { 'agents/slides.ts': agent, 'surfaces/main.ts': surface },
});

describe('slides approval', () => {
  it('renders the deck only after approval, and reads without asking', () => {
    expect((agent.skills ?? []).map((skill) => skill.name)).toContain('office-writer');
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
    expect(agent.files).toEqual([expect.objectContaining({ path: 'slides', access: 'read' })]);
  });
});

describe('slides typed output', () => {
  it('asks its typed eval runs for the outline, each slide with its sources', async () => {
    const text = await readFile(new URL('evals/slides.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/slides.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        required: ['title', 'date', 'slides', 'openPoints'],
        additionalProperties: false,
        properties: { slides: { items: { required: ['title', 'bullets', 'sources'] } } },
      });
    }
  });
});
