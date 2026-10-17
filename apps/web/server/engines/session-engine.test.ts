import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ENGINE_ID,
  engineForStoredPolicy,
  pinSessionEngine,
  publishedEngineId,
  sessionEngineMismatchMessage,
} from './session-engine';

const TEST_ENGINE = 'test-only-engine';

describe('engineForStoredPolicy', () => {
  it('reads the engine off a stored policy', () => {
    expect(engineForStoredPolicy({ engine: 'claude-agent-sdk' })).toBe('claude-agent-sdk');
  });

  it('answers the default arm for an agent with no stored policy', () => {
    // The same engine `compiledPolicyFor` serves for a NULL column, so `GET /policy` and a run
    // cannot disagree about which engine an unconfigured agent belongs to.
    expect(engineForStoredPolicy(null)).toBe(DEFAULT_ENGINE_ID);
    expect(DEFAULT_ENGINE_ID).toBe('claude-agent-sdk');
  });
});

describe('publishedEngineId', () => {
  it('narrows an engine the contracts publish', () => {
    expect(publishedEngineId('claude-agent-sdk')).toBe('claude-agent-sdk');
  });

  it('reports an engine the contracts do not publish rather than defaulting it', () => {
    // Recording `claude-agent-sdk` here would make a guess indistinguishable from a measurement.
    expect(() => publishedEngineId(TEST_ENGINE)).toThrow('not one this platform');
  });
});

describe('pinSessionEngine', () => {
  it('lets an unpinned session take the agent’s engine', () => {
    expect(pinSessionEngine({ sessionEngine: null, agentEngine: 'claude-agent-sdk' })).toEqual({
      kind: 'pinned',
      engine: 'claude-agent-sdk',
    });
  });

  it('keeps a pinned session on its own engine when the agent agrees', () => {
    expect(
      pinSessionEngine({ sessionEngine: 'claude-agent-sdk', agentEngine: 'claude-agent-sdk' }),
    ).toEqual({ kind: 'pinned', engine: 'claude-agent-sdk' });
  });

  it('refuses a pinned session whose agent now names another engine', () => {
    expect(
      pinSessionEngine({ sessionEngine: 'claude-agent-sdk', agentEngine: TEST_ENGINE }),
    ).toEqual({
      kind: 'mismatch',
      sessionEngine: 'claude-agent-sdk',
      agentEngine: TEST_ENGINE,
    });
  });

  it('refuses in the other direction too: the session is not re-pinned by a new agent engine', () => {
    // ADR-0065 D8 is symmetric. A session pinned to a test-only engine is not silently adopted by
    // the platform's default engine either.
    expect(
      pinSessionEngine({ sessionEngine: TEST_ENGINE, agentEngine: 'claude-agent-sdk' }),
    ).toEqual({
      kind: 'mismatch',
      sessionEngine: TEST_ENGINE,
      agentEngine: 'claude-agent-sdk',
    });
  });

  it('reports an unpinned session whose agent names an unpublishable engine', () => {
    expect(() => pinSessionEngine({ sessionEngine: null, agentEngine: TEST_ENGINE })).toThrow(
      'not one this platform',
    );
  });
});

describe('sessionEngineMismatchMessage', () => {
  it('names both engines and the way out', () => {
    const message = sessionEngineMismatchMessage({
      sessionEngine: 'claude-agent-sdk',
      agentEngine: TEST_ENGINE,
    });
    expect(message).toContain('claude-agent-sdk');
    expect(message).toContain(TEST_ENGINE);
    expect(message).toContain('omit sessionId');
  });
});
