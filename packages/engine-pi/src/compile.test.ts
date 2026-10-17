/**
 * `compilePiRun`: every portable field, and every refusal by its code (ENG-08, #307).
 */
import type { EngineRunRequest } from '@agent-workspace/engine';
import { describe, expect, it } from 'vitest';

import {
  compilePiRun,
  PI_DEFAULT_ANTHROPIC_MODEL,
  PI_GATEWAY_API_KEY_PLACEHOLDER,
  piModelConnection,
  type PiCompiled,
} from './compile.js';

const SESSION = '7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6';

function request(overrides: Partial<EngineRunRequest> = {}): EngineRunRequest {
  return {
    runId: 'run-1',
    sessionId: SESSION,
    projectKey: 'tenant',
    cwd: '/workspace/tenant/',
    prompt: 'go',
    engine: 'pi',
    portable: {
      name: 'Writer',
      instructions: 'Write clearly.',
      model: 'claude-sonnet-4-5',
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        unrestrictedNetwork: true,
      },
      skills: { mode: 'allowlist', names: ['writer'] },
      mcpServers: {},
      limits: { maxTurns: 7, maxBudgetUsd: null },
    },
    policy: { thinkingLevel: 'medium' },
    session: { mode: 'fresh' },
    gateway: {
      baseUrl: 'https://gateway.test/',
      token: 'run-token',
      protocol: 'anthropic-messages',
    },
    resources: {
      files: [{ kind: 'file', path: 'contract.pdf', access: 'read' }],
      skills: [
        { name: 'writer', files: [] },
        { name: 'reviewer', files: [] },
      ],
    },
    env: { PATH: '/usr/bin', HOME: '/workspace/tenant' },
    ...overrides,
  };
}

function compiled(overrides: Partial<EngineRunRequest> = {}): PiCompiled {
  const result = compilePiRun(request(overrides));
  if (!result.ok) throw new Error(result.reason);
  return result.compiled;
}

describe('compilePiRun', () => {
  it('compiles every portable field', () => {
    const out = compiled();
    expect(out.agent).toEqual({
      name: 'Writer',
      appendSystemPrompt: 'Write clearly.',
      model: 'claude-sonnet-4-5',
      thinkingLevel: 'medium',
      // A read-only grant withholds bash.
      tools: ['read', 'write', 'edit'],
    });
    expect(out.connection).toEqual({
      protocol: 'anthropic-messages',
      provider: 'anthropic',
      baseUrl: 'https://gateway.test',
      headers: { authorization: 'Bearer run-token' },
      apiKey: PI_GATEWAY_API_KEY_PLACEHOLDER,
    });
    expect(out.networkEgress).toBe(true);
    expect(out.limits).toEqual({ maxTurns: 7, budget: null });
    expect(out.workspace).toEqual({
      cwd: '/workspace/tenant',
      grants: [{ kind: 'file', path: 'contract.pdf', access: 'read', segments: ['contract.pdf'] }],
      protectedDirectory: '.pi',
    });
    expect(out.resources).toEqual({
      skillsDirectory: '.pi/skills',
      skills: ['writer'],
      agentDirectory: '.pi/agent',
    });
    expect(out.env).toEqual({ PATH: '/usr/bin', HOME: '/workspace/tenant' });
    expect(out.session).toEqual({
      mode: 'fresh',
      engineSessionId: SESSION,
      parentSessionId: null,
      projectKey: 'tenant',
    });
  });

  it('is pure: the same request compiles to the same JSON', () => {
    expect(JSON.stringify(compiled())).toBe(JSON.stringify(compiled()));
  });

  it("offers exactly the tools the four switches allow, and pi's defaults otherwise", () => {
    const none = compiled({
      resources: { files: [], skills: [] },
      policy: {},
      portable: {
        ...request().portable,
        model: null,
        skills: { mode: 'all' },
        permissions: {
          readFiles: false,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      },
    });
    expect(none.agent.tools).toEqual([]);
    expect(none.networkEgress).toBe(false);
    expect(none.agent.thinkingLevel).toBe('off');
    expect(none.agent.model).toBe(PI_DEFAULT_ANTHROPIC_MODEL);
    expect(none.resources.skills).toEqual([]);

    const all = compiled({ resources: { files: [], skills: [] } });
    expect(all.agent.tools).toEqual(['read', 'write', 'edit', 'bash']);
  });

  it('carries a priced budget cap', () => {
    const out = compiled({
      portable: { ...request().portable, limits: { maxTurns: null, maxBudgetUsd: 2 } },
    });
    expect(out.limits.budget).toMatchObject({ maxBudgetUsd: 2, model: 'claude-sonnet-4-5' });
    expect(out.limits.budget?.price.inputUsdPerMillion).toBe('3');
  });

  it('resumes under the id the request carries, and forks under the new session id', () => {
    expect(
      compiled({ session: { mode: 'resume', engineSessionId: 'earlier' } }).session,
    ).toMatchObject({ mode: 'resume', engineSessionId: 'earlier', parentSessionId: null });
    expect(
      compiled({ session: { mode: 'fork', engineSessionId: 'earlier' } }).session,
    ).toMatchObject({
      mode: 'fork',
      engineSessionId: SESSION,
      parentSessionId: 'earlier',
    });
  });

  it.each<[string, Partial<EngineRunRequest>, string, RegExp]>([
    [
      'an unreadable policy arm',
      { policy: { tools: null } },
      'engine_policy_invalid',
      /thinkingLevel/u,
    ],
    [
      'an unknown thinking level',
      { policy: { thinkingLevel: 'xhigh' } },
      'engine_policy_invalid',
      /thinkingLevel/u,
    ],
    [
      'a grant into .pi',
      {
        resources: {
          files: [{ kind: 'file', path: '.pi/settings.json', access: 'read-write' }],
          skills: [],
        },
      },
      'engine_policy_invalid',
      /\.pi/u,
    ],
    [
      'a connector',
      {
        portable: {
          ...request().portable,
          mcpServers: { 'docs-server': { type: 'http', url: 'https://mcp.test' } },
        },
      },
      'engine_capability_unsupported',
      /mcp: false.*docs-server/u,
    ],
    [
      'a subagent',
      {
        portable: {
          ...request().portable,
          subagents: [
            {
              name: 'billing-specialist',
              description: 'Answers billing questions.',
              instructions: 'You answer billing questions.',
              model: null,
              permissions: request().portable.permissions,
            },
          ],
        },
      },
      'engine_capability_unsupported',
      /subagents: false.*"billing-specialist"/u,
    ],
    [
      'a cap on an unpriced model',
      {
        portable: {
          ...request().portable,
          model: 'claude-unlisted',
          limits: { maxTurns: null, maxBudgetUsd: 1 },
        },
      },
      'engine_capability_unsupported',
      /claude-unlisted/u,
    ],
    [
      'an OpenAI-family connection',
      { gateway: { baseUrl: 'https://gateway.test', token: 't', protocol: 'openai-responses' } },
      'engine_capability_unsupported',
      /openai-responses/u,
    ],
    ['no gateway connection', { gateway: null }, 'engine_credential_refused', /gateway/u],
    [
      'a provider credential in the environment',
      { env: { ANTHROPIC_API_KEY: 'sk-ant-real' } },
      'engine_credential_refused',
      /ANTHROPIC_API_KEY/u,
    ],
    [
      'a fork into itself',
      { session: { mode: 'fork', engineSessionId: SESSION } },
      'engine_policy_invalid',
      /fork/u,
    ],
  ])('refuses %s', (_name, overrides, code, reason) => {
    const result = compilePiRun(request(overrides));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(code);
    expect(result.reason).toMatch(reason);
  });
});

describe('piModelConnection', () => {
  it('targets the gateway base URL alone and carries the run token as a bearer', () => {
    expect(piModelConnection({ baseUrl: 'http://gw:8787///', token: 'abc' })).toEqual({
      protocol: 'anthropic-messages',
      provider: 'anthropic',
      baseUrl: 'http://gw:8787',
      headers: { authorization: 'Bearer abc' },
      apiKey: PI_GATEWAY_API_KEY_PLACEHOLDER,
    });
  });
});
