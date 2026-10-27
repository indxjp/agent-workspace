/**
 * The compile prelude (#951): every helper on both branches, with the sentences an adapter's
 * refusal carries.
 */
import { ENGINE_CATALOGUE } from '@indx-workspace/contracts/engines';
import { describe, expect, it } from 'vitest';

import {
  approvalsRefusal,
  forkRefusal,
  normaliseRequestGrants,
  outputSchemaRefusal,
  parsePolicyArm,
  provisionalBudget,
  refuse,
  requireGateway,
  sandboxRefusal,
  subagentBudgetRefusal,
  subagentsRefusal,
  subagentToolNames,
  PROVIDER_TOOL_NAME_MAX_LENGTH,
  type PolicyArmParser,
} from './compile-checks.js';
import type { EngineRunRequest } from './port.js';

function request(overrides: Partial<EngineRunRequest> = {}): EngineRunRequest {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    projectKey: 'tenant',
    cwd: '/workspace/tenant',
    prompt: 'go',
    engine: 'demo',
    portable: {
      name: 'Writer',
      instructions: '',
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        unrestrictedNetwork: false,
      },
      skills: { mode: 'allowlist', names: [] },
      mcpServers: {},
      limits: { maxTurns: null, maxBudgetUsd: null },
    },
    policy: {},
    session: { mode: 'fresh' },
    gateway: {
      baseUrl: 'https://gateway.test',
      token: 'run-token',
      protocol: 'anthropic-messages',
    },
    resources: { files: [], skills: [] },
    env: {},
    ...overrides,
  };
}

describe('refuse', () => {
  it('builds the typed refusal', () => {
    expect(refuse('engine_policy_invalid', 'because')).toEqual({
      ok: false,
      code: 'engine_policy_invalid',
      reason: 'because',
    });
  });
});

describe('parsePolicyArm', () => {
  const parser: PolicyArmParser<{ level: number }> = {
    safeParse: (value) =>
      typeof value === 'object' && value !== null && 'level' in value && value.level === 1
        ? { success: true, data: { level: 1 } }
        : { success: false, error: { message: 'level must be 1' } },
  };

  it('returns the parsed arm', () => {
    expect(parsePolicyArm('demo', parser, '{ level }', { level: 1 })).toEqual({
      ok: true,
      policy: { level: 1 },
    });
  });

  it('refuses a malformed arm and carries the parser message', () => {
    expect(parsePolicyArm('demo', parser, '{ level }', 'nope')).toEqual({
      ok: false,
      code: 'engine_policy_invalid',
      reason: 'the demo policy arm must be an object carrying { level }; level must be 1',
    });
  });
});

describe('normaliseRequestGrants', () => {
  it('normalises the grants', () => {
    const verdict = normaliseRequestGrants(
      request({
        resources: { files: [{ kind: 'file', path: './a//b.txt', access: 'read' }], skills: [] },
      }),
      '.demo',
    );
    expect(verdict.ok ? verdict.grants.map((grant) => grant.path) : []).toEqual(['a/b.txt']);
  });

  it('refuses a grant that climbs out of the workspace', () => {
    const verdict = normaliseRequestGrants(
      request({
        resources: { files: [{ kind: 'file', path: '../etc', access: 'read' }], skills: [] },
      }),
      '.demo',
    );
    expect(verdict).toMatchObject({ ok: false, code: 'engine_policy_invalid' });
  });

  it('refuses a grant inside the protected directory', () => {
    const verdict = normaliseRequestGrants(
      request({
        resources: {
          files: [{ kind: 'directory', path: '.demo/skills', access: 'read-write' }],
          skills: [],
        },
      }),
      '.demo',
    );
    expect(verdict).toMatchObject({ ok: false, code: 'engine_policy_invalid' });
    expect(verdict.ok ? '' : verdict.reason).toContain('".demo"');
  });
});

describe('requireGateway', () => {
  const protocols = ['anthropic-messages'] as const;

  it('returns the gateway and the protocol it is served over', () => {
    const verdict = requireGateway('demo', request(), protocols);
    expect(verdict).toMatchObject({ ok: true, protocol: 'anthropic-messages' });
  });

  it('refuses a request without a gateway as a credential problem', () => {
    expect(requireGateway('demo', request({ gateway: null }), protocols)).toEqual({
      ok: false,
      code: 'engine_credential_refused',
      reason:
        'demo reaches its model only through the gateway connection on the request, and this request carries none.',
    });
  });

  it('refuses a protocol the engine does not speak', () => {
    const gateway = { baseUrl: 'https://gateway.test', token: 't', protocol: 'openai-responses' };
    expect(requireGateway('demo', request({ gateway }), protocols)).toEqual({
      ok: false,
      code: 'engine_capability_unsupported',
      reason:
        'demo speaks anthropic-messages to the gateway; this run\'s connection is served over "openai-responses".',
    });
  });
});

describe('sandboxRefusal', () => {
  it('passes an environment without credentials', () => {
    expect(sandboxRefusal({ PATH: '/usr/bin' }, 'run-token')).toBeNull();
  });

  it('refuses a credential that is not the run token', () => {
    const refusal = sandboxRefusal({ OPENAI_API_KEY: 'sk-real' }, 'run-token');
    expect(refusal).toMatchObject({ ok: false, code: 'engine_credential_refused' });
    expect(refusal?.reason).toContain('OPENAI_API_KEY');
  });
});

describe('subagentsRefusal', () => {
  const named = [{ name: 'billing' }, { name: 'legal' }];

  it('refuses subagents by name on an engine that declares subagents: false', () => {
    expect(subagentsRefusal('pi', ENGINE_CATALOGUE.pi.capabilities, named)).toEqual({
      ok: false,
      code: 'engine_capability_unsupported',
      reason:
        'pi declares subagents: false (ADR-0133 D14), so the subagent(s) "billing", "legal" cannot be honoured. Remove them from the agent or choose an engine with subagents.',
    });
  });

  it('lets no subagents through anywhere, and any subagents through an engine that declares them', () => {
    expect(subagentsRefusal('pi', ENGINE_CATALOGUE.pi.capabilities, undefined)).toBeNull();
    expect(subagentsRefusal('pi', ENGINE_CATALOGUE.pi.capabilities, [])).toBeNull();
    expect(
      subagentsRefusal(
        'claude-agent-sdk',
        ENGINE_CATALOGUE['claude-agent-sdk'].capabilities,
        named,
      ),
    ).toBeNull();
  });
});

describe('subagentBudgetRefusal', () => {
  const subagents = [
    { name: 'same', model: 'gpt-5' },
    { name: 'inherits', model: null },
    { name: 'other', model: 'gpt-5-mini' },
  ];

  it('refuses, by name, a subagent on another model when a cap is set', () => {
    expect(subagentBudgetRefusal('mastra', 'gpt-5', 1, subagents)).toEqual({
      ok: false,
      code: 'engine_capability_unsupported',
      reason:
        'mastra prices a maxBudget cap with the agent\'s model "gpt-5" alone (ADR-0074 D7), so the subagent(s) "other" on another model cannot be metered. Run them on the agent\'s model or remove the cap.',
    });
  });

  it('lets any model through without a cap, and the parent model or an inherited one with it', () => {
    expect(subagentBudgetRefusal('mastra', 'gpt-5', null, subagents)).toBeNull();
    expect(subagentBudgetRefusal('mastra', 'gpt-5', 1, subagents.slice(0, 2))).toBeNull();
    expect(subagentBudgetRefusal('mastra', 'gpt-5', 1, undefined)).toBeNull();
  });
});

describe('forkRefusal', () => {
  it('refuses a fork on an engine that declares fork: false', () => {
    expect(
      forkRefusal('mastra', ENGINE_CATALOGUE.mastra.capabilities, {
        mode: 'fork',
        engineSessionId: 'parent',
      }),
    ).toEqual({
      ok: false,
      code: 'engine_capability_unsupported',
      reason: 'mastra declares fork: false, so a session cannot be branched on this engine.',
    });
  });

  it('lets a fork through on an engine that can fork, and any other mode through anywhere', () => {
    expect(
      forkRefusal('pi', ENGINE_CATALOGUE.pi.capabilities, { mode: 'fork', engineSessionId: 'p' }),
    ).toBeNull();
    expect(
      forkRefusal('mastra', ENGINE_CATALOGUE.mastra.capabilities, { mode: 'fresh' }),
    ).toBeNull();
  });
});

describe('outputSchemaRefusal', () => {
  it('refuses an output schema on an engine without structured output, naming it', () => {
    const refused = outputSchemaRefusal('pi', false, { type: 'object' });
    expect(refused?.code).toBe('engine_capability_unsupported');
    expect(refused?.reason).toContain('pi declares structuredOutput: false');
  });

  it('lets a request through with no schema, or on an engine with structured output', () => {
    expect(outputSchemaRefusal('pi', false, undefined)).toBeNull();
    expect(outputSchemaRefusal('claude-agent-sdk', true, { type: 'object' })).toBeNull();
  });
});

describe('approvalsRefusal', () => {
  it('refuses requireApproval on an engine without approvals, naming the rules', () => {
    const refused = approvalsRefusal('pi', false, ['Write', 'mcp__gh__push']);
    expect(refused?.code).toBe('engine_capability_unsupported');
    expect(refused?.reason).toContain('pi declares approvals: false');
    expect(refused?.reason).toContain('"mcp__gh__push"');
  });

  it('lets a request through with no rules, or on an engine with approvals', () => {
    expect(approvalsRefusal('pi', false, [])).toBeNull();
    expect(approvalsRefusal('claude-agent-sdk', true, ['Write'])).toBeNull();
  });
});

describe('provisionalBudget', () => {
  it('has no budget without a cap', () => {
    expect(provisionalBudget('demo', 'claude-sonnet-4-5', null)).toBeNull();
  });

  it('prices a cap for a known model', () => {
    const budget = provisionalBudget('demo', 'claude-sonnet-4-5', 2);
    expect(budget).toMatchObject({ maxBudgetUsd: 2, model: 'claude-sonnet-4-5' });
    expect(budget !== null && !('ok' in budget)).toBe(true);
  });

  it('refuses a cap on a model the table cannot price', () => {
    const budget = provisionalBudget('demo', 'no-such-model', 2);
    expect(budget).toMatchObject({ ok: false, code: 'engine_capability_unsupported' });
    expect(budget !== null && 'reason' in budget ? budget.reason : '').toContain(
      'demo enforces maxBudget from a provisional price table (ADR-0074 D7, checked',
    );
  });
});

describe('subagentToolNames', () => {
  it('sanitises each name into a provider tool name, in order', () => {
    expect(
      subagentToolNames('openai-agents', 'subagent_', [{ name: 'code-reviewer' }, { name: 'a b' }]),
    ).toEqual({
      ok: true,
      named: [
        { name: 'code-reviewer', toolName: 'subagent_code-reviewer' },
        { name: 'a b', toolName: 'subagent_a_b' },
      ],
    });
    expect(subagentToolNames('mastra', 'agent-', undefined)).toEqual({ ok: true, named: [] });
  });

  it('refuses, by name, two subagents that map to one tool name', () => {
    expect(
      subagentToolNames('mastra', 'agent-', [{ name: 'Code Reviewer' }, { name: 'Code_Reviewer' }]),
    ).toMatchObject({
      ok: false,
      code: 'engine_capability_unsupported',
      reason: expect.stringContaining('"Code_Reviewer"') as unknown,
    });
  });

  it('refuses, by name, a tool name longer than a provider accepts', () => {
    const name = 'x'.repeat(PROVIDER_TOOL_NAME_MAX_LENGTH - 'subagent_'.length + 1);
    expect(subagentToolNames('openai-agents', 'subagent_', [{ name }])).toMatchObject({
      ok: false,
      code: 'engine_capability_unsupported',
      reason: expect.stringContaining(JSON.stringify(name)) as unknown,
    });
    expect(
      subagentToolNames('openai-agents', 'subagent_', [{ name: name.slice(1) }]),
    ).toMatchObject({ ok: true });
  });
});
