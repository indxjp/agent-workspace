/**
 * The newcomer use case (archetype DR: it answers a new joiner's questions and drafts the
 * first-week guide): the contract and moment tiers from the kit, and a check that its one write,
 * the guide rendered by `office-writer`, waits for a person while searching runs unasked.
 */
import { describe, expect, it } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/newcomer.ts';
import surface from './surfaces/main.ts';

describeUseCase('newcomer', {
  definitions: { 'agents/newcomer.ts': agent, 'surfaces/main.ts': surface },
});

describe('newcomer approval', () => {
  it('renders the guide only after approval, and searches without asking', () => {
    expect((agent.skills ?? []).map((skill) => skill.name)).toContain('office-writer');
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
    expect(agent.files).toEqual([expect.objectContaining({ path: 'newcomer', access: 'read' })]);
  });
});
