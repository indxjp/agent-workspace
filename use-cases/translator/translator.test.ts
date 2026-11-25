/**
 * The translator use case (archetype DR): the contract and moment tiers from the kit; a check that
 * reading a Word original and rendering the translation both wait for a person while searching
 * runs unasked.
 */
import { describe, expect, it } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/translator.ts';
import surface from './surfaces/main.ts';

describeUseCase('translator', {
  definitions: { 'agents/translator.ts': agent, 'surfaces/main.ts': surface },
});

describe('translator approval', () => {
  it('reads Word and renders the translation only after approval', () => {
    expect((agent.skills ?? []).map((skill) => skill.name)).toEqual([
      'office-reader',
      'office-writer',
      'translator',
    ]);
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
  });
});
