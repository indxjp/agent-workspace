/**
 * Characterization of every refusal `agents/policy.ts` answers, pinned as the whole `ApiResult`
 * (status and body), so moving the rules into `agents/core/policy.ts` (refactoring plan part 07,
 * step 1) cannot change one character of what a client receives.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentPolicy } from '../../contracts/agents';
import {
  carryEngineSwitch,
  compiledPolicyFor,
  dangerousPermissionModeRefusal,
  engineCapabilityRefusal,
  parsePolicyBody,
  unsupportedEngineRefusal,
} from './policy';
import {
  clearEnginesRegisteredForTests,
  registerEngineForTests,
  type RegisteredEngine,
} from '../engines/registry';

const VALID = {
  engine: 'claude-agent-sdk',
  tools: {
    base: 'claude_code_preset',
    autoApprove: [],
    deny: [],
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
  },
  skills: { mode: 'all' },
  limits: { maxTurns: null, maxBudgetUsd: null },
} as const;

function refusalOf(result: ReturnType<typeof parsePolicyBody>): unknown {
  if (result.ok) throw new Error('expected a refusal');
  return result.result;
}

describe('parsePolicyBody refusals, whole result', () => {
  it('the pre-ADR-0065 provider discriminant', () => {
    expect(refusalOf(parsePolicyBody({ provider: 'claude-agent-sdk' }))).toStrictEqual({
      status: 400,
      body: {
        error: {
          code: 'invalid_body',
          message:
            "The policy discriminant is 'engine', naming the harness that runs the agent loop. " +
            "'provider' names the model provider and is no longer accepted here (ADR-0065).",
        },
      },
    });
  });

  it('an engine this deployment does not register', () => {
    expect(
      refusalOf(parsePolicyBody({ ...VALID, engine: 'acp' }, ['claude-agent-sdk'])),
    ).toStrictEqual({
      status: 400,
      body: {
        error: {
          code: 'unsupported_engine',
          message: 'This deployment registers the engines \'claude-agent-sdk\'; received "acp".',
        },
      },
    });
  });

  it('a body that does not match the published shape, with one detail line per issue', () => {
    const result = refusalOf(parsePolicyBody({ engine: 'claude-agent-sdk' }, ['claude-agent-sdk']));
    expect(result).toMatchObject({
      status: 400,
      body: {
        error: {
          code: 'invalid_policy',
          message: 'The policy body does not match the published shape.',
        },
      },
    });
    const details = (result as { body: { error: { details: readonly string[] } } }).body.error
      .details;
    expect(details.length).toBeGreaterThan(0);
    for (const line of details) expect(line).toMatch(/^(\(root\)|[\w.]+): ./u);
  });

  it('a parseable bypassPermissions policy', () => {
    const body = {
      ...VALID,
      tools: {
        ...VALID.tools,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    };
    expect(refusalOf(parsePolicyBody(body, ['claude-agent-sdk']))).toStrictEqual({
      status: 400,
      body: {
        error: {
          code: 'dangerous_permission_mode_refused',
          message: "permissionMode 'bypassPermissions' cannot be set through this route.",
        },
      },
    });
  });

  it('accepts a well-formed policy as itself', () => {
    expect(parsePolicyBody(VALID, ['claude-agent-sdk'])).toStrictEqual({ ok: true, policy: VALID });
  });
});

describe('the other refusals, whole result', () => {
  afterEach(() => {
    clearEnginesRegisteredForTests();
  });

  it('unsupportedEngineRefusal with details', () => {
    expect(
      unsupportedEngineRefusal('acp', ['claude-agent-sdk', 'openai-agents'], ['x']),
    ).toStrictEqual({
      status: 400,
      body: {
        error: {
          code: 'unsupported_engine',
          message:
            "This deployment registers the engines 'claude-agent-sdk', 'openai-agents'; received \"acp\".",
          details: ['x'],
        },
      },
    });
  });

  it('dangerousPermissionModeRefusal is null for a policy without tools', () => {
    const openai: AgentPolicy = {
      engine: 'openai-agents',
      skills: { mode: 'all' },
      limits: { maxTurns: null, maxBudgetUsd: null },
    };
    expect(dangerousPermissionModeRefusal(openai)).toBeNull();
  });

  it('engineCapabilityRefusal for an engine without MCP', () => {
    const noMcp: RegisteredEngine = {
      id: 'claude-agent-sdk',
      displayName: 'Claude Agent SDK (test: no MCP)',
      version: 'test',
      capabilities: {
        mcp: false,
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
      },
    };
    registerEngineForTests(noMcp);
    expect(
      engineCapabilityRefusal('claude-agent-sdk', { connectors: true, skills: false }),
    ).toMatchSnapshot();
  });

  it('carryEngineSwitch refusing denials: two labelled, one raw', () => {
    const B = '00000000-0000-4000-8000-0000000000b2';
    const C = '00000000-0000-4000-8000-0000000000c3';
    const compiled = compiledPolicyFor(
      { readFiles: true, writeFiles: false, runCommands: false, unrestrictedNetwork: true },
      [],
    );
    const withDeny = (deny: string[]): AgentPolicy => ({
      ...compiled,
      tools: { ...compiled.tools, deny },
    });
    const stored = withDeny([`mcp__connector-${B}__delete`, `mcp__connector-${C}__drop`, 'Bash']);
    const openai: AgentPolicy = {
      engine: 'openai-agents',
      skills: { mode: 'allowlist', names: [] },
      limits: { maxTurns: 20, maxBudgetUsd: null },
    };
    expect(
      carryEngineSwitch(stored, openai, { [`connector-${B}`]: 'file-finder' }),
    ).toMatchSnapshot();
    expect(carryEngineSwitch(withDeny([`mcp__connector-${B}__delete`]), openai)).toMatchSnapshot();
    expect(carryEngineSwitch(null, openai)).toStrictEqual({ ok: true, policy: openai });
  });
});
