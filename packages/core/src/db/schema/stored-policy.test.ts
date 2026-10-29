import { describe, expect, it } from 'vitest';

import { AgentPolicySchema } from '@indx-workspace/contracts/agents';
import { ENGINE_IDS } from '@indx-workspace/contracts/engines';

import { AgentStoredPolicy, parseAgentPolicy } from './agents.js';

const COMMON = {
  skills: { mode: 'all' },
  limits: { maxTurns: null, maxBudgetUsd: null },
} as const;

const CLAUDE_TOOLS = {
  base: 'claude_code_preset',
  autoApprove: [],
  deny: [],
  permissionMode: 'default',
  allowDangerouslySkipPermissions: false,
} as const;

const ACCEPTED: readonly (readonly [string, unknown])[] = [
  ['claude', { engine: 'claude-agent-sdk', tools: CLAUDE_TOOLS, ...COMMON }],
  [
    'claude with a tool list and an allowlist',
    {
      engine: 'claude-agent-sdk',
      tools: { ...CLAUDE_TOOLS, base: ['Read'], autoApprove: ['Read'], deny: ['Bash'] },
      skills: { mode: 'allowlist', names: ['a', 'b'] },
      limits: { maxTurns: 3, maxBudgetUsd: 1.5 },
    },
  ],
  [
    'claude with approval rules and handoff',
    {
      engine: 'claude-agent-sdk',
      tools: CLAUDE_TOOLS,
      requireApproval: ['mcp__aw-control__draft_save'],
      handoff: true,
      ...COMMON,
    },
  ],
  ['openai-agents bare', { engine: 'openai-agents', ...COMMON }],
  [
    'openai-agents with settings',
    {
      engine: 'openai-agents',
      reasoningEffort: 'high',
      parallelToolCalls: false,
      withheldPermissions: ['runCommands'],
      ...COMMON,
    },
  ],
  ['pi bare', { engine: 'pi', ...COMMON }],
  ['pi off', { engine: 'pi', thinkingLevel: 'off', withheldPermissions: ['readFiles'], ...COMMON }],
  ['mastra 1', { engine: 'mastra', toolCallConcurrency: 1, ...COMMON }],
  [
    'mastra 16',
    { engine: 'mastra', toolCallConcurrency: 16, withheldPermissions: ['writeFiles'], ...COMMON },
  ],
];

const REFUSED: readonly (readonly [string, unknown])[] = [
  ['an unknown key', { engine: 'pi', extra: true, ...COMMON }],
  ['reasoningEffort xhigh', { engine: 'openai-agents', reasoningEffort: 'xhigh', ...COMMON }],
  ['toolCallConcurrency 17', { engine: 'mastra', toolCallConcurrency: 17, ...COMMON }],
  ['thinkingLevel on openai-agents', { engine: 'openai-agents', thinkingLevel: 'low', ...COMMON }],
  ['tools on pi', { engine: 'pi', tools: CLAUDE_TOOLS, ...COMMON }],
  ['requireApproval on pi', { engine: 'pi', requireApproval: ['Bash'], ...COMMON }],
  ['an unknown permission', { engine: 'pi', withheldPermissions: ['root'], ...COMMON }],
  ['an engine this build lacks', { engine: 'acp:codex', ...COMMON }],
  ['the pre-ADR-0065 discriminant', { engine: 'provider', ...COMMON }],
  ['claude without tools', { engine: 'claude-agent-sdk', ...COMMON }],
];

describe('AgentStoredPolicy', () => {
  it.each(ACCEPTED)('accepts %s and returns it unchanged', (_name, value) => {
    expect(AgentStoredPolicy.parse(value)).toStrictEqual(value);
  });

  it.each(REFUSED)('refuses %s', (_name, value) => {
    expect(AgentStoredPolicy.safeParse(value).success).toBe(false);
  });

  it('has one arm per published engine', () => {
    expect(AgentStoredPolicy.options.map((arm) => arm.shape.engine.value)).toStrictEqual([
      ...ENGINE_IDS,
    ]);
  });

  it.each(ACCEPTED)('stores what the contracts policy produces for %s', (_name, value) => {
    const wire = AgentPolicySchema.parse(value);
    expect(AgentStoredPolicy.parse(wire)).toStrictEqual(wire);
  });

  it('reads NULL as no stored policy', () => {
    expect(parseAgentPolicy(null)).toBeNull();
    expect(parseAgentPolicy(undefined)).toBeNull();
  });
});
