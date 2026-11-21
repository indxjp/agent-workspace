/**
 * The work-instruction use case (archetype DR): the contract, moment and flow tiers from the kit; a
 * check that its one write, the document rendered by `office-writer`, waits for a person while
 * reading runs unasked; and a check that the eval cases asking for typed output ask for the
 * outline, every section with the transcript times and safety clauses it rests on.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/work-instruction.ts';
import surface from './surfaces/main.ts';

describeUseCase('work-instruction', {
  definitions: { 'agents/work-instruction.ts': agent, 'surfaces/main.ts': surface },
});

describe('work-instruction approval', () => {
  it('renders the document only after approval, and reads without asking', () => {
    expect((agent.skills ?? []).map((skill) => skill.name)).toContain('office-writer');
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
    expect(agent.files).toEqual([
      expect.objectContaining({ path: 'work-instruction', access: 'read' }),
    ]);
  });
});

describe('work-instruction typed output', () => {
  it('asks its typed eval runs for the outline, each section with its sources', async () => {
    const text = await readFile(new URL('evals/work-instruction.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/work-instruction.yaml').cases.flatMap(
      (evalCase) => (evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema]),
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        required: ['title', 'sections', 'openPoints'],
        properties: { sections: { items: { required: ['heading', 'points', 'sources'] } } },
      });
    }
  });
});
