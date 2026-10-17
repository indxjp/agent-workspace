import { describe, expect, it } from 'vitest';

import { AGENT_POLICY_PROBLEM_CODES } from './agents.js';
import {
  ENGINE_BUDGET_ENFORCEMENTS,
  ENGINE_CAPABILITY_KEYS,
  ENGINE_IDS,
  ENGINE_LIMIT_ENFORCEMENTS,
  ENGINE_PROBLEM_CODES,
  EngineCapabilitiesSchema,
  EngineCapabilityKeySchema,
  EngineDescriptorSchema,
  EngineIdSchema,
  EngineListResponseSchema,
  WIRE_PROTOCOLS,
  WireProtocolSchema,
} from './engines.js';

const capabilities = {
  mcp: true,
  skills: true,
  subagents: false,
  resume: true,
  fork: false,
  interrupt: true,
  streamingText: false,
  reasoning: true,
  maxTurns: 'native',
  maxBudget: 'native',
  wireProtocols: ['anthropic-messages'],
};

const descriptor = {
  id: 'claude-agent-sdk',
  displayName: 'Claude Agent SDK',
  version: '0.3.278',
  capabilities,
  installed: true,
};

describe('engine identifiers', () => {
  it('lists claude-agent-sdk, then openai-agents (ENG-09, #308), then pi (ENG-08, #307), then mastra (ENG-10, #309), and nothing else', () => {
    expect(ENGINE_IDS).toEqual(['claude-agent-sdk', 'openai-agents', 'pi', 'mastra']);
  });

  it('accepts every listed id and refuses an engine no deployment can run', () => {
    for (const id of ENGINE_IDS) expect(EngineIdSchema.parse(id)).toBe(id);
    expect(EngineIdSchema.safeParse('acp').success).toBe(false);
    // The model provider list is a different vocabulary; neither may stand in for the other.
    expect(EngineIdSchema.safeParse('anthropic').success).toBe(false);
  });

  it('keeps the three wire protocols in the order the gateway ingresses are specified in', () => {
    expect(WIRE_PROTOCOLS).toEqual([
      'anthropic-messages',
      'openai-responses',
      'openai-chat-completions',
    ]);
    for (const protocol of WIRE_PROTOCOLS)
      expect(WireProtocolSchema.parse(protocol)).toBe(protocol);
    expect(WireProtocolSchema.safeParse('gemini-generate-content').success).toBe(false);
  });
});

describe('EngineCapabilitiesSchema', () => {
  it('round-trips a full capability set', () => {
    expect(EngineCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
  });

  it('rejects an unknown key rather than dropping it', () => {
    const parsed = EngineCapabilitiesSchema.safeParse({ ...capabilities, hitl: true });
    expect(parsed.success).toBe(false);
  });

  it('requires every capability to be stated', () => {
    for (const key of Object.keys(capabilities)) {
      const partial: Record<string, unknown> = { ...capabilities };
      delete partial[key];
      expect(EngineCapabilitiesSchema.safeParse(partial).success).toBe(false);
    }
  });

  it('accepts every enforcement value the two limit fields publish', () => {
    for (const maxTurns of ENGINE_LIMIT_ENFORCEMENTS) {
      expect(EngineCapabilitiesSchema.safeParse({ ...capabilities, maxTurns }).success).toBe(true);
    }
    for (const maxBudget of ENGINE_BUDGET_ENFORCEMENTS) {
      expect(EngineCapabilitiesSchema.safeParse({ ...capabilities, maxBudget }).success).toBe(true);
    }
    // `none` is a budget answer only: a turn cap is always enforceable somewhere.
    expect(EngineCapabilitiesSchema.safeParse({ ...capabilities, maxTurns: 'none' }).success).toBe(
      false,
    );
  });

  it('refuses an engine that can reach no gateway ingress', () => {
    expect(EngineCapabilitiesSchema.safeParse({ ...capabilities, wireProtocols: [] }).success).toBe(
      false,
    );
    expect(
      EngineCapabilitiesSchema.safeParse({ ...capabilities, wireProtocols: ['telepathy'] }).success,
    ).toBe(false);
  });

  it('refuses a capability set without `subagents`', () => {
    const withoutSubagents = Object.fromEntries(
      Object.entries(capabilities).filter(([key]) => key !== 'subagents'),
    );
    expect(EngineCapabilitiesSchema.safeParse(withoutSubagents).success).toBe(false);
  });
});

describe('EngineDescriptorSchema', () => {
  it('round-trips the descriptor a deployment advertises', () => {
    expect(EngineDescriptorSchema.parse(descriptor)).toEqual(descriptor);
  });

  it('rejects an unknown key and an empty display name or version', () => {
    expect(EngineDescriptorSchema.safeParse({ ...descriptor, note: 'x' }).success).toBe(false);
    expect(EngineDescriptorSchema.safeParse({ ...descriptor, displayName: '' }).success).toBe(
      false,
    );
    expect(EngineDescriptorSchema.safeParse({ ...descriptor, version: '' }).success).toBe(false);
  });

  it('carries `installed` as a stated fact, never an absent one', () => {
    const withoutInstalled = Object.fromEntries(
      Object.entries(descriptor).filter(([key]) => key !== 'installed'),
    );
    expect(EngineDescriptorSchema.safeParse(withoutInstalled).success).toBe(false);
  });
});

describe('ENGINE_CAPABILITY_KEYS', () => {
  it('names the capabilities an assignment can demand, in wire order', () => {
    expect(ENGINE_CAPABILITY_KEYS).toEqual(['mcp', 'skills', 'subagents']);
  });

  it('is a subset of the capability set, so a refusal names a field an engine really has', () => {
    const fields = Object.keys(EngineCapabilitiesSchema.parse(capabilities));
    for (const key of ENGINE_CAPABILITY_KEYS) expect(fields).toContain(key);
  });

  it('refuses a capability outside the three, so a refusal cannot name a run-time one', () => {
    expect(EngineCapabilityKeySchema.safeParse('mcp').success).toBe(true);
    expect(EngineCapabilityKeySchema.safeParse('skills').success).toBe(true);
    expect(EngineCapabilityKeySchema.safeParse('subagents').success).toBe(true);
    expect(EngineCapabilityKeySchema.safeParse('resume').success).toBe(false);
    expect(EngineCapabilityKeySchema.safeParse('interrupt').success).toBe(false);
  });
});

describe('EngineListResponseSchema', () => {
  it('round-trips the catalogue `GET /api/engines` answers with', () => {
    expect(EngineListResponseSchema.parse({ engines: [descriptor] })).toEqual({
      engines: [descriptor],
    });
  });

  it('accepts a deployment that registers nothing at all', () => {
    expect(EngineListResponseSchema.parse({ engines: [] })).toEqual({ engines: [] });
  });

  it('rejects a bare array, an unknown key and a descriptor that fails its own schema', () => {
    expect(EngineListResponseSchema.safeParse([descriptor]).success).toBe(false);
    expect(EngineListResponseSchema.safeParse({ engines: [descriptor], total: 1 }).success).toBe(
      false,
    );
    expect(
      EngineListResponseSchema.safeParse({ engines: [{ ...descriptor, id: 'acp' }] }).success,
    ).toBe(false);
  });

  it('requires the envelope key rather than defaulting it to empty', () => {
    expect(EngineListResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe('ENGINE_PROBLEM_CODES', () => {
  it('answers an unregistered engine with 400', () => {
    expect(ENGINE_PROBLEM_CODES.unsupported_engine).toBe(400);
  });

  it('answers a session pinned to another engine with 409, not 400', () => {
    // The request is well formed; the session has a history this run does not belong to.
    expect(ENGINE_PROBLEM_CODES.session_engine_mismatch).toBe(409);
  });

  it('answers an assignment the engine cannot honour with 422', () => {
    expect(ENGINE_PROBLEM_CODES.engine_capability_unsupported).toBe(422);
  });

  it('answers a catalogue this contract cannot express with 500, not a filtered 200', () => {
    expect(ENGINE_PROBLEM_CODES.engine_catalogue_invalid).toBe(500);
  });

  it('agrees with the agent policy statuses for the codes both tables name', () => {
    // `AGENT_POLICY_PROBLEM_CODES` restates the status as a literal so the two tables stay
    // independent declarations; this is what keeps them from drifting apart.
    expect(ENGINE_PROBLEM_CODES.unsupported_engine).toBe(
      AGENT_POLICY_PROBLEM_CODES.unsupported_engine,
    );
    expect(ENGINE_PROBLEM_CODES.engine_capability_unsupported).toBe(
      AGENT_POLICY_PROBLEM_CODES.engine_capability_unsupported,
    );
  });
});
