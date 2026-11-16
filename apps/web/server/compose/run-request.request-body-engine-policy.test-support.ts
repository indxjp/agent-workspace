import { QUIET_CLAUDE_ENVIRONMENT } from '@agent-workspace/engine';
import { compileRunRequest } from '@agent-workspace/engine-claude-agent-sdk/testing';
import { AgentPolicySchema } from '@indx-workspace/contracts/agents';
import { expect, it } from 'vitest';

import { buildRunRequestFor } from './run-request';
import {
  GATEWAY,
  launchContext,
  rowRunAgent,
  SETTINGS,
  WORKSPACE,
} from './run-request.fixture.test-support';
export function registerEnginePolicyCases() {
  it('compiles the Claude arm from the stored tools, or from none', async () => {
    const { context, agents } = await launchContext();
    const request = await buildRunRequestFor({
      context,
      runAgent: await rowRunAgent(agents, context),
      settings: SETTINGS,
      gateway: GATEWAY,
    });

    expect(request.engine).toBe('claude-agent-sdk');
    expect(request.policy).toStrictEqual({ tools: null, fileGrantDeny: [] });
  });
  it('puts the gate and the calls a decision admitted into the Claude arm (ADR-0145)', async () => {
    const { context, agents, agentId } = await launchContext();
    await agents.forWorkspace(WORKSPACE).replacePolicy(
      agentId,
      AgentPolicySchema.parse({
        engine: 'claude-agent-sdk',
        tools: {
          base: 'claude_code_preset',
          autoApprove: [],
          deny: [],
          permissionMode: 'default',
          allowDangerouslySkipPermissions: false,
        },
        requireApproval: ['Bash'],
        skills: { mode: 'all' },
        limits: { maxTurns: null, maxBudgetUsd: null },
      }),
    );
    const decided = {
      ...context,
      run: {
        ...context.run,
        approvedToolCalls: [{ toolName: 'Bash', canonicalCall: 'Bash {"command":"ls"}' }],
      },
    };

    const request = await buildRunRequestFor({
      context: decided,
      runAgent: await rowRunAgent(agents, decided),
      settings: SETTINGS,
      gateway: GATEWAY,
    });

    expect(request.policy).toMatchObject({
      requireApproval: ['Bash'],
      approvedToolCalls: ['Bash {"command":"ls"}'],
    });
    const first = await buildRunRequestFor({
      context,
      runAgent: await rowRunAgent(agents, context),
      settings: SETTINGS,
      gateway: GATEWAY,
    });
    expect(first.policy).not.toHaveProperty('approvedToolCalls');
  });
  it('forwards the handoff opt-in only when the stored Claude arm has it (ADR-0145 D4)', async () => {
    const { context, agents, agentId } = await launchContext();
    const stored = (handoff: boolean) =>
      AgentPolicySchema.parse({
        engine: 'claude-agent-sdk',
        tools: {
          base: 'claude_code_preset',
          autoApprove: [],
          deny: [],
          permissionMode: 'default',
          allowDangerouslySkipPermissions: false,
        },
        ...(handoff ? { handoff: true } : {}),
        skills: { mode: 'all' },
        limits: { maxTurns: null, maxBudgetUsd: null },
      });
    const policyOf = async () =>
      (
        await buildRunRequestFor({
          context,
          runAgent: await rowRunAgent(agents, context),
          settings: SETTINGS,
          gateway: GATEWAY,
        })
      ).policy;

    await agents.forWorkspace(WORKSPACE).replacePolicy(agentId, stored(true));
    expect(await policyOf()).toMatchObject({ handoff: true });
    await agents.forWorkspace(WORKSPACE).replacePolicy(agentId, stored(false));
    expect(await policyOf()).not.toHaveProperty('handoff');
  });
  it('mints a fresh token for every serialization and closes the A.11 environment', async () => {
    const { context, agents } = await launchContext();
    const first = await buildRunRequestFor({
      context,
      runAgent: await rowRunAgent(agents, context),
      settings: SETTINGS,
      gateway: GATEWAY,
      agentSecrets: {
        ASSIGNED_AGENT_SECRET: 'agent-only',
      },
    });
    const second = await buildRunRequestFor({
      context,
      runAgent: await rowRunAgent(agents, context),
      settings: SETTINGS,
      gateway: GATEWAY,
      agentSecrets: {
        ASSIGNED_AGENT_SECRET: 'agent-only',
      },
    });
    expect(first.env['ANTHROPIC_AUTH_TOKEN']).not.toBe(second.env['ANTHROPIC_AUTH_TOKEN']);

    const compiled = compileRunRequest(first);
    const spec = await import('node:fs/promises').then(({ readFile }) =>
      readFile(new URL('../../../../docs/spec.md', import.meta.url), 'utf8'),
    );
    const section = spec.slice(
      spec.indexOf('## A.11 Environment contract'),
      spec.indexOf('## A.12 Driver conformance'),
    );
    const tableNames = [...section.matchAll(/^\| `([^`]+)`/gmu)].flatMap((match) =>
      (match[1] ?? '').split(' / '),
    );
    const conditional = new Set([
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'agent secrets',
    ]);
    const mandatory = tableNames.filter((name) => !conditional.has(name));
    expect(mandatory).toEqual([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CONFIG_DIR',
      'AGENT_WORKSPACE_RUN_ID',
      'AGENT_WORKSPACE_SESSION_ID',
      'NODE_USE_ENV_PROXY',
    ]);
    for (const name of mandatory) expect(compiled.env[name]).toBeTruthy();
    expect(compiled.env['NODE_USE_ENV_PROXY']).toBe('1');
    expect(compiled.env['AW_SESSION_MIRROR_TOKEN']).toBe(compiled.env['ANTHROPIC_AUTH_TOKEN']);
    // The Claude engine always sets these three flags; they are not part of the A.11 table.
    for (const [name, value] of Object.entries(QUIET_CLAUDE_ENVIRONMENT)) {
      expect(compiled.env[name]).toBe(value);
    }
    expect(Object.keys(compiled.env).sort()).toEqual(
      [
        ...mandatory,
        ...Object.keys(QUIET_CLAUDE_ENVIRONMENT),
        'AW_SESSION_MIRROR_TOKEN',
        'CLAUDE_CODE_PROJECT_DIR_NAME',
        'ENABLE_TOOL_SEARCH',
        'ASSIGNED_AGENT_SECRET',
      ].sort(),
    );
  });
}
