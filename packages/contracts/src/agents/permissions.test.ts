import { describe, expect, it } from 'vitest';

import { meetPolicyCeiling } from '../policy-ceiling.js';
import {
  AGENT_MEMORY_FILE,
  AGENT_MEMORY_MAX_BYTES,
  AGENT_MEMORY_MAX_FILES,
  AGENT_PERMISSION_KEYS,
  AgentPermissionsSchema,
  agentMemoryEnabled,
  agentMemoryFolder,
  type AgentPermissions,
} from './permissions.js';
import { policyNarrowedPermissions } from './policy.js';

const FILES_ON: AgentPermissions = {
  readFiles: true,
  writeFiles: true,
  runCommands: false,
  unrestrictedNetwork: false,
};

describe('the memory permission (ADR-0163)', () => {
  it('is optional: the four switches alone still parse, unchanged and without a memory key', () => {
    const parsed = AgentPermissionsSchema.parse(FILES_ON);
    expect(parsed).toEqual(FILES_ON);
    expect('memory' in parsed).toBe(false);
  });

  it('accepts the agent scope next to the switches', () => {
    expect(AgentPermissionsSchema.parse({ ...FILES_ON, memory: 'agent' })).toEqual({
      ...FILES_ON,
      memory: 'agent',
    });
  });

  it.each([['agent+user'], ['user'], [true], [''], [null]])(
    'refuses an unknown memory value: %j',
    (memory) => {
      expect(AgentPermissionsSchema.safeParse({ ...FILES_ON, memory }).success).toBe(false);
    },
  );

  it('is not one of the withholdable switches', () => {
    expect(AGENT_PERMISSION_KEYS).not.toContain('memory');
  });

  it('is in force only while both file switches are on', () => {
    expect(agentMemoryEnabled({ ...FILES_ON, memory: 'agent' })).toBe(true);
    expect(agentMemoryEnabled(FILES_ON)).toBe(false);
    expect(agentMemoryEnabled({ ...FILES_ON, readFiles: false, memory: 'agent' })).toBe(false);
    expect(agentMemoryEnabled({ ...FILES_ON, writeFiles: false, memory: 'agent' })).toBe(false);
  });

  it('names one folder per agent id, the memory file and the bounds', () => {
    expect(agentMemoryFolder('agent-1')).toBe('memory/agent-1');
    expect(AGENT_MEMORY_FILE).toBe('memory/MEMORY.md');
    expect(AGENT_MEMORY_MAX_FILES).toBe(64);
    expect(AGENT_MEMORY_MAX_BYTES).toBe(256 * 1024);
  });

  it('survives the withholding narrowing, which can still turn its file switches off', () => {
    const narrowed = policyNarrowedPermissions(
      { ...FILES_ON, memory: 'agent' },
      {
        engine: 'openai-agents',
        skills: { mode: 'all' },
        limits: { maxTurns: null, maxBudgetUsd: null },
        withheldPermissions: ['writeFiles'],
      },
    );
    expect(narrowed.memory).toBe('agent');
    expect(agentMemoryEnabled(narrowed)).toBe(false);
  });

  it('survives the ceiling meet, and a ceiling that caps a file switch turns memory off', () => {
    const effective = {
      permissions: { ...FILES_ON, memory: 'agent' as const },
      limits: { maxTurns: null, maxBudgetUsd: null },
      engine: 'claude-agent-sdk' as const,
      model: null,
      tools: [],
    };
    const open = meetPolicyCeiling(effective, {});
    expect(open.permissions.memory).toBe('agent');
    expect(agentMemoryEnabled(open.permissions)).toBe(true);
    const capped = meetPolicyCeiling(effective, { permissions: { writeFiles: false } });
    expect(agentMemoryEnabled(capped.permissions)).toBe(false);
    // Without memory, the meet's result is as it was: no memory key at all.
    const plain = meetPolicyCeiling({ ...effective, permissions: FILES_ON }, {});
    expect('memory' in plain.permissions).toBe(false);
  });
});
