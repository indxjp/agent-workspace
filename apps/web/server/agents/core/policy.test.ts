import { describe, expect, it } from 'vitest';

import type { AgentPolicy } from '@indx-workspace/contracts/agents';

import { carryEngineSwitch, policySourceOf } from './policy';

const OPENAI: AgentPolicy = {
  engine: 'openai-agents',
  skills: { mode: 'all' },
  limits: { maxTurns: null, maxBudgetUsd: null },
};

describe('policySourceOf', () => {
  it('is compiled for a NULL column and stored for a set one', () => {
    expect(policySourceOf({ policy: null })).toBe('compiled');
    expect(policySourceOf({ policy: OPENAI })).toBe('stored');
  });
});

describe('carryEngineSwitch', () => {
  it('carries nothing when no policy was ever stored', () => {
    expect(carryEngineSwitch(null, OPENAI)).toStrictEqual({ ok: true, policy: OPENAI });
  });

  it('answers a refusal as data, not as an HTTP result', () => {
    const stored: AgentPolicy = {
      engine: 'claude-agent-sdk',
      tools: {
        base: 'claude_code_preset',
        autoApprove: [],
        deny: ['mcp__connector-00000000-0000-4000-8000-0000000000b2__delete'],
        permissionMode: 'default',
        allowDangerouslySkipPermissions: false,
      },
      skills: { mode: 'all' },
      limits: { maxTurns: null, maxBudgetUsd: null },
    };
    const carried = carryEngineSwitch(stored, OPENAI);
    expect(carried.ok).toBe(false);
    if (!carried.ok) {
      expect(carried.refusal).toMatchObject({
        status: 422,
        code: 'engine_switch_would_widen',
        details: ['mcp__connector-00000000-0000-4000-8000-0000000000b2__delete'],
      });
      expect(carried.refusal).not.toHaveProperty('body');
    }
  });
});
