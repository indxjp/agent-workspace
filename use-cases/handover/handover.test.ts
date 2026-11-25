/**
 * The handover use case (archetype DR): the contract, moment and flow tiers from the kit; a check
 * that its one write, the pack rendered by `office-writer`, waits for a person while reading runs
 * unasked; and a check that the eval cases asking for typed output ask for the outline, every
 * section with the ids of the files it rests on, and hold no field that assesses a person.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/handover.ts';
import surface from './surfaces/main.ts';

describeUseCase('handover', {
  definitions: { 'agents/handover.ts': agent, 'surfaces/main.ts': surface },
});

describe('handover approval', () => {
  it('renders the pack only after approval, and reads without asking', () => {
    expect((agent.skills ?? []).map((skill) => skill.name)).toContain('office-writer');
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
    expect(agent.files).toEqual([expect.objectContaining({ path: 'handover', access: 'read' })]);
  });
});

describe('handover typed output', () => {
  it('asks for the outline by section, with sources, and no field about a person', async () => {
    const text = await readFile(new URL('evals/handover.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/handover.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        additionalProperties: false,
        required: ['title', 'from', 'to', 'sections', 'openPoints'],
        properties: { sections: { items: { required: ['heading', 'points', 'sources'] } } },
      });
      const fields = [...JSON.stringify(schema).matchAll(/"([A-Za-z]+)":/g)].map(
        ([, name]) => name,
      );
      for (const field of fields) {
        expect(field).not.toMatch(/^(rating|score|performance|evaluation|assessment)$/);
      }
    }
  });
});
