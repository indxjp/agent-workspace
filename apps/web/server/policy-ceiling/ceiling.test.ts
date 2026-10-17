import { policyWidenings } from '@indx-workspace/contracts/policy-ceiling';
import { describe, expect, it } from 'vitest';

import { agentEffective, assignedTools, enforceCeiling, judgedModel } from './ceiling';
import { CEILING_ACTOR, recordingCeilingFor } from './fixtures';

const request = new Request('http://localhost/api/agents');
const CONNECTION = '00000000-0000-4000-8000-000000000001';
const ALL_ON = { readFiles: true, writeFiles: true, runCommands: true, unrestrictedNetwork: true };

const wide = {
  permissions: ALL_ON,
  limits: { maxTurns: 50, maxBudgetUsd: 9 },
  engine: 'pi' as const,
  model: 'gpt-x',
  tools: ['zeta', 'alpha', 'zeta'],
};
const ceilingPolicy = {
  permissions: { runCommands: false, readFiles: false },
  limits: { maxTurns: 10, maxBudgetUsd: 1 },
  engines: ['claude-agent-sdk' as const],
  models: ['claude-sonnet-4-5'],
  tools: [],
};

describe('enforceCeiling (issue #535)', () => {
  it('answers 403 policy_cannot_widen with policyWidenings in C14 order, and audits it', async () => {
    const { ceilingFor, audit } = recordingCeilingFor(ceilingPolicy);
    const result = await enforceCeiling(wide, ceilingFor(request, CEILING_ACTOR.workspaceId), {
      id: '00000000-0000-4000-8000-00000000000c',
      label: 'Support',
    });
    const details = policyWidenings(wide, ceilingPolicy);
    expect(details).toEqual([
      'permissions.readFiles',
      'permissions.runCommands',
      'limits.maxTurns',
      'limits.maxBudgetUsd',
      'engine:pi',
      'model:gpt-x',
      'tool:alpha',
      'tool:zeta',
    ]);
    expect(result).toEqual({
      status: 403,
      body: {
        error: {
          code: 'policy_cannot_widen',
          message: "The agent would be wider than this deployment's policy ceiling allows.",
          details,
        },
      },
    });
    expect(audit).toEqual([
      {
        workspaceId: CEILING_ACTOR.workspaceId,
        actorPrincipalId: CEILING_ACTOR.principalId,
        actorUserId: null,
        actorLabel: CEILING_ACTOR.label,
        action: 'agent-changed',
        subjectId: '00000000-0000-4000-8000-00000000000c',
        subjectLabel: `Support: refused policy_cannot_widen ${details.join(', ')}`,
      },
    ]);
  });

  it('writes nothing for a dry run (audit null) and answers the same refusal', async () => {
    const { ceilingFor, audit } = recordingCeilingFor(ceilingPolicy);
    const ceiling = ceilingFor(request, CEILING_ACTOR.workspaceId);
    const dry = await enforceCeiling(wide, ceiling, null);
    const save = await enforceCeiling(wide, ceiling, { id: null, label: 'Support' });
    expect(dry).toEqual(save);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.subjectId).toBeNull();
  });

  it('passes a configuration within the ceiling, and anything without a ceiling', async () => {
    const { ceilingFor } = recordingCeilingFor(ceilingPolicy);
    const within = {
      permissions: { ...ALL_ON, readFiles: false, runCommands: false },
      limits: { maxTurns: null, maxBudgetUsd: null },
      engine: 'claude-agent-sdk' as const,
      model: null,
      tools: [],
    };
    expect(await enforceCeiling(within, ceilingFor(request, 'ws'), { id: null, label: 'x' })).toBe(
      null,
    );
    expect(await enforceCeiling(wide, null, { id: null, label: 'x' })).toBeNull();
    expect(await enforceCeiling(wide, undefined, null)).toBeNull();
  });
});

describe('judgedModel and the deployment default (SD6)', () => {
  it('prefers an explicit model and looks nothing up', async () => {
    const { ceilingFor, lookups } = recordingCeilingFor({ models: ['a'] });
    expect(await judgedModel('b', CONNECTION, ceilingFor(request, 'ws'))).toBe('b');
    expect(lookups).toEqual([]);
  });

  it('makes no lookup when the ceiling names no models', async () => {
    const { ceilingFor, lookups } = recordingCeilingFor(
      { engines: ['claude-agent-sdk'] },
      { defaults: { anthropic: 'claude-sonnet-4-5' }, providers: { [CONNECTION]: 'anthropic' } },
    );
    expect(await judgedModel(null, CONNECTION, ceilingFor(request, 'ws'))).toBeNull();
    expect(lookups).toEqual([]);
  });

  it("reads the deployment default for the connection's provider", async () => {
    const { ceilingFor, lookups } = recordingCeilingFor(
      { models: ['a'] },
      { defaults: { openai: 'gpt-5.1' }, providers: { [CONNECTION]: 'openai' } },
    );
    expect(await judgedModel(null, CONNECTION, ceilingFor(request, 'ws'))).toBe('gpt-5.1');
    expect(await judgedModel(null, null, ceilingFor(request, 'ws'))).toBeNull();
    expect(lookups).toEqual([`provider:${CONNECTION}`]);
  });

  it('judges no model when the provider has no deployment default or the connection is gone', async () => {
    const { ceilingFor } = recordingCeilingFor(
      { models: ['a'] },
      { defaults: { openai: 'gpt-5.1' }, providers: { [CONNECTION]: 'anthropic' } },
    );
    const ceiling = ceilingFor(request, 'ws');
    expect(await judgedModel(null, CONNECTION, ceiling)).toBeNull();
    expect(await judgedModel(null, '00000000-0000-4000-8000-0000000000ff', ceiling)).toBeNull();
  });
});

describe('agentEffective and assignedTools', () => {
  it('narrows withheld permissions, reads stored limits and engine, compiled as the default arm', async () => {
    const { ceilingFor } = recordingCeilingFor({ models: ['m'] });
    const ceiling = ceilingFor(request, 'ws');
    const compiled = await agentEffective(
      { permissions: ALL_ON, policy: null, model: 'm', modelConnectionId: null },
      ['t'],
      ceiling,
    );
    expect(compiled).toEqual({
      permissions: ALL_ON,
      limits: { maxTurns: null, maxBudgetUsd: null },
      engine: 'claude-agent-sdk',
      model: 'm',
      tools: ['t'],
    });
  });

  it('reads connector names only under a tools ceiling, dropping ids the workspace lacks', async () => {
    const none = recordingCeilingFor({ models: ['m'] });
    expect(await assignedTools(['c1'], none.ceilingFor(request, 'ws'))).toEqual([]);
    expect(none.lookups).toEqual([]);
    const tools = recordingCeilingFor({ tools: ['web'] }, { connectors: { c1: 'web' } });
    expect(await assignedTools(['c1', 'c2'], tools.ceilingFor(request, 'ws'))).toEqual(['web']);
  });
});
