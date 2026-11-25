/**
 * The kyt use case (archetype DR): the contract, moment and flow tiers from the kit; a check that
 * its one write, the KY sheet rendered by `office-writer`, waits for a person while reading runs
 * unasked; and a check that the eval cases asking for typed output ask for hazards that each rest
 * on a source, with no field for the key hazards or the action goal, which the team decides.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/kyt.ts';
import surface from './surfaces/main.ts';

describeUseCase('kyt', {
  definitions: { 'agents/kyt.ts': agent, 'surfaces/main.ts': surface },
});

describe('kyt approval', () => {
  it('renders the KY sheet only after approval, and reads without asking', () => {
    expect((agent.skills ?? []).map((skill) => skill.name)).toContain('office-writer');
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
    expect(agent.files).toEqual([expect.objectContaining({ path: 'kyt', access: 'read' })]);
  });
});

describe('kyt typed output', () => {
  it('asks for hazards that each rest on a source, and leaves the team its choices', async () => {
    const text = await readFile(new URL('evals/kyt.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/kyt.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        additionalProperties: false,
        properties: {
          hazards: {
            items: {
              required: ['scene', 'hazard', 'measures', 'sources'],
              additionalProperties: false,
              properties: { sources: { minItems: 1 } },
            },
          },
        },
      });
      expect(JSON.stringify(schema)).not.toMatch(/"(keyHazards|actionGoal|callWords)"/);
    }
  });
});
