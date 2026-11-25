/**
 * The tests use case (archetype DR): the contract, moment and flow tiers from the kit; a check that
 * its one write, the test design rendered by `office-writer`, waits for a person while reading runs
 * unasked; and a check that the eval cases asking for typed output ask for the test cases, each with
 * its requirement, its kind and the ids it rests on.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/tests.ts';
import surface from './surfaces/main.ts';

describeUseCase('tests', {
  definitions: { 'agents/tests.ts': agent, 'surfaces/main.ts': surface },
});

describe('tests approval', () => {
  it('renders the document only after approval, and reads without asking', () => {
    expect((agent.skills ?? []).map((skill) => skill.name)).toContain('office-writer');
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
    expect(agent.files).toEqual([expect.objectContaining({ path: 'tests', access: 'read' })]);
  });
});

describe('tests typed output', () => {
  it('asks its typed eval runs for the test cases, each with its requirement and sources', async () => {
    const text = await readFile(new URL('evals/tests.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/tests.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        required: ['title', 'spec', 'cases', 'openPoints'],
        properties: {
          cases: {
            items: { required: ['id', 'requirement', 'kind', 'input', 'expected', 'sources'] },
          },
        },
      });
    }
  });
});
