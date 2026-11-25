/**
 * The faq-builder use case (archetype DR): the contract, moment and flow tiers from the kit; a check
 * that its one write, the FAQ rendered by `office-writer`, waits for a person while reading runs
 * unasked; and a check that the eval cases asking for typed output ask for the outline, every entry
 * with the tickets and guides it rests on.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/faq-builder.ts';
import surface from './surfaces/main.ts';

describeUseCase('faq-builder', {
  definitions: { 'agents/faq-builder.ts': agent, 'surfaces/main.ts': surface },
});

describe('faq-builder approval', () => {
  it('renders the FAQ only after approval, and reads without asking', () => {
    expect((agent.skills ?? []).map((skill) => skill.name)).toContain('office-writer');
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
    expect(agent.files).toEqual([expect.objectContaining({ path: 'faq-builder', access: 'read' })]);
  });
});

describe('faq-builder typed output', () => {
  it('asks its typed eval runs for the outline, each entry with its tickets and sources', async () => {
    const text = await readFile(new URL('evals/faq-builder.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/faq-builder.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        required: ['title', 'entries', 'openPoints'],
        properties: {
          entries: {
            items: { required: ['category', 'question', 'answer', 'tickets', 'sources'] },
          },
        },
      });
    }
  });
});
