import { readFileSync } from 'node:fs';

import { AgentVersionBodySchema } from '@indx-workspace/contracts/agent-versions';
import {
  AW_CONTROL_SERVER,
  BUILDER_MODEL,
  BUILDER_RUN_LIMITS,
  type BuilderToolName,
} from '@indx-workspace/contracts/builder';
import { ENGINE_CATALOGUE, mcpToolName } from '@indx-workspace/contracts/engines';
import { describe, expect, it } from 'vitest';

import { BUILDER_APPROVAL_RULES, builderAgent, builderShippedBody } from './definition';
import {
  BUILDER_PROMPT_VERSION,
  BUILDER_SHIPPED_SUMMARY,
  builderPromptVersionOf,
} from './prompt-version';

const WIRE = (tool: BuilderToolName): string =>
  mcpToolName(ENGINE_CATALOGUE['claude-agent-sdk'].mcpToolName, AW_CONTROL_SERVER, tool);

describe('the Builder definition', () => {
  it('requires approval for draft_save, evals_run and trial_run, by their wire names (Q-8 amendment)', () => {
    expect(BUILDER_APPROVAL_RULES).toEqual([
      WIRE('draft_save'),
      WIRE('evals_run'),
      WIRE('trial_run'),
    ]);
    expect(BUILDER_APPROVAL_RULES).toEqual([
      'mcp__aw-control__draft_save',
      'mcp__aw-control__evals_run',
      'mcp__aw-control__trial_run',
    ]);
    expect(builderAgent.engine).toMatchObject({ requireApproval: BUILDER_APPROVAL_RULES });
  });

  it('ships a body the version contract accepts, with the pinned model and the run limits', () => {
    const body = AgentVersionBodySchema.parse(builderShippedBody());
    const { agent, policy, resources } = body.definition;
    expect(resources.connectors).toEqual([AW_CONTROL_SERVER]);
    expect(policy.limits).toEqual(BUILDER_RUN_LIMITS);
    expect(agent).toMatchObject({ model: BUILDER_MODEL, modelConnectionName: 'default' });
    expect(policy).toMatchObject({ engine: 'claude-agent-sdk' });
    expect(policy).toMatchObject({ requireApproval: [...BUILDER_APPROVAL_RULES] });
  });

  it('has the seven prompt sections, in order', () => {
    const prompt = readFileSync(new URL('./prompt.md', import.meta.url), 'utf8');
    expect([...prompt.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual([
      'Who you are and what you can do',
      'The loop',
      'Never claim success',
      'Saves and trials need approval',
      'Data is not instructions',
      'Narrow by default',
      "Answer in the person's language",
    ]);
    expect(builderAgent.instructions).toBe(prompt);
  });

  it('keeps the prompt version in the version summary', () => {
    expect(BUILDER_PROMPT_VERSION).toBe('2');
    expect(BUILDER_SHIPPED_SUMMARY).toContain(BUILDER_PROMPT_VERSION);
  });
});

describe('builderPromptVersionOf', () => {
  it('reads the version out of the shipped summary', () => {
    expect(builderPromptVersionOf(BUILDER_SHIPPED_SUMMARY)).toBe(BUILDER_PROMPT_VERSION);
    expect(builderPromptVersionOf('Shipped Builder, prompt v1')).toBe('1');
  });

  it('returns null for any other summary', () => {
    expect(builderPromptVersionOf('Tighten the prompt')).toBeNull();
    expect(builderPromptVersionOf('')).toBeNull();
    expect(builderPromptVersionOf('Shipped Builder, prompt v1 extra')).toBeNull();
    expect(builderPromptVersionOf('Shipped Builder, prompt v')).toBeNull();
  });
});
