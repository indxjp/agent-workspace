/**
 * The release-notes use case (archetype DR): the contract, moment and flow tiers from the kit; a
 * check that its one write, the document rendered by `office-writer`, waits for a person while
 * reading runs unasked; and a check that the eval cases asking for typed output ask for the groups,
 * every item with the number of the PR it comes from.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/release-notes.ts';
import surface from './surfaces/main.ts';

describeUseCase('release-notes', {
  definitions: { 'agents/release-notes.ts': agent, 'surfaces/main.ts': surface },
});

describe('release-notes approval', () => {
  it('renders the document only after approval, and reads without asking', () => {
    expect((agent.skills ?? []).map((skill) => skill.name)).toContain('office-writer');
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
    expect(agent.files).toEqual([
      expect.objectContaining({ path: 'release-notes', access: 'read' }),
    ]);
  });
});

describe('release-notes typed output', () => {
  it('asks its typed eval runs for the groups, each item with its PR number', async () => {
    const text = await readFile(new URL('evals/release-notes.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/release-notes.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        required: ['title', 'groups', 'leftOut', 'openPoints'],
        properties: {
          groups: { items: { properties: { items: { items: { required: ['text', 'pr'] } } } } },
        },
      });
    }
  });
});
