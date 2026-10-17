import type { EngineCapabilities } from '@indx-workspace/contracts/engines';
import { describe, expect, it } from 'vitest';

import {
  engineCapabilityRefusalMessage,
  unsupportedEngineCapability,
  type EngineCapabilityDemand,
} from './capabilities';

/** The Claude Agent SDK's shape, which honours both assignable resources. */
const ALL: EngineCapabilities = {
  mcp: true,
  skills: true,
  subagents: true,
  resume: true,
  fork: false,
  interrupt: true,
  streamingText: false,
  reasoning: true,
  maxTurns: 'native',
  maxBudget: 'native',
  wireProtocols: ['anthropic-messages'],
};

const DEMANDS: readonly EngineCapabilityDemand[] = [
  { connectors: false, skills: false },
  { connectors: true, skills: false },
  { connectors: false, skills: true },
  { connectors: true, skills: true },
];

describe('unsupportedEngineCapability', () => {
  it('refuses exactly the agents whose demand the engine cannot honour, in both directions', () => {
    // The T1 statement, enumerated: four demands crossed with four capability sets. "Exactly" is
    // the part worth testing — an engine that refused a little too eagerly would also satisfy a
    // one-sided assertion.
    for (const mcp of [true, false]) {
      for (const skills of [true, false]) {
        const capabilities: EngineCapabilities = { ...ALL, mcp, skills };
        for (const demand of DEMANDS) {
          const honours = (!demand.connectors || mcp) && (!demand.skills || skills);
          const verdict = unsupportedEngineCapability(capabilities, demand);
          expect(verdict === null, JSON.stringify({ mcp, skills, demand, verdict })).toBe(honours);
        }
      }
    }
  });

  it('never fires for an engine that honours both, whatever the agent is assigned', () => {
    // The acceptance criterion "nothing changes for claude-agent-sdk agents", at this function.
    for (const demand of DEMANDS) expect(unsupportedEngineCapability(ALL, demand)).toBeNull();
  });

  it('names mcp for a connector the engine cannot speak to', () => {
    expect(
      unsupportedEngineCapability({ ...ALL, mcp: false }, { connectors: true, skills: false }),
    ).toBe('mcp');
  });

  it('names skills for a skill the engine cannot materialise', () => {
    expect(
      unsupportedEngineCapability({ ...ALL, skills: false }, { connectors: false, skills: true }),
    ).toBe('skills');
  });

  it('names subagents for a subagent the engine cannot delegate to, after mcp and skills', () => {
    const demand = { connectors: true, skills: true, subagents: true };
    expect(unsupportedEngineCapability({ ...ALL, subagents: false }, demand)).toBe('subagents');
    expect(unsupportedEngineCapability({ ...ALL, subagents: false, skills: false }, demand)).toBe(
      'skills',
    );
    expect(unsupportedEngineCapability(ALL, demand)).toBeNull();
    // A caller that never states the demand (the agent and policy routes) is not refused.
    expect(
      unsupportedEngineCapability({ ...ALL, subagents: false }, { connectors: true, skills: true }),
    ).toBeNull();
  });

  it('names one capability at a time, connectors first, when both are unsupported', () => {
    expect(
      unsupportedEngineCapability(
        { ...ALL, mcp: false, skills: false },
        { connectors: true, skills: true },
      ),
    ).toBe('mcp');
  });

  it('ignores a capability the agent does not demand', () => {
    // An engine with no MCP is perfectly usable by an agent with no connectors: the refusal is
    // about the pairing, never about the engine on its own.
    expect(
      unsupportedEngineCapability(
        { ...ALL, mcp: false, skills: false },
        { connectors: false, skills: false },
      ),
    ).toBeNull();
  });
});

describe('engineCapabilityRefusalMessage', () => {
  it('names the engine, the capability and what the caller assigned', () => {
    const message = engineCapabilityRefusalMessage('pi', 'mcp');
    expect(message).toContain("'pi'");
    expect(message).toContain('mcp');
    expect(message).toContain('connectors');
  });

  it('says skills rather than connectors for the skills capability', () => {
    const message = engineCapabilityRefusalMessage('pi', 'skills');
    expect(message).toContain('skills');
    expect(message).not.toContain('connectors');
  });

  it('says subagents for the subagents capability', () => {
    const message = engineCapabilityRefusalMessage('pi', 'subagents');
    expect(message).toContain('does not support subagents');
    expect(message).toContain('assigned subagents');
  });
});
