/**
 * `compileOpenAiAgentsRun`: every portable field, and every refusal by its code (ENG-09, #308).
 */
import type { EngineRunRequest } from '@agent-workspace/engine';
import { describe, expect, it } from 'vitest';

import { compileOpenAiAgentsRun, type OpenAiAgentsCompiled } from './compile.js';

const BASE: EngineRunRequest = {
  runId: 'r',
  sessionId: 's-1',
  projectKey: 'tenant-a',
  cwd: '/workspace/run/',
  prompt: 'go',
  engine: 'openai-agents',
  portable: {
    name: 'Agent',
    instructions: 'Be brief.',
    model: 'gpt-test',
    permissions: {
      readFiles: true,
      writeFiles: true,
      runCommands: true,
      unrestrictedNetwork: true,
    },
    skills: { mode: 'allowlist', names: [] },
    mcpServers: {},
    limits: { maxTurns: 7, maxBudgetUsd: null },
  },
  policy: { reasoningEffort: 'low', parallelToolCalls: false },
  session: { mode: 'fresh' },
  gateway: { baseUrl: 'http://gateway.test/', token: 'tok', protocol: 'openai-responses' },
  resources: { files: [], skills: [] },
  env: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'tok' },
};

function compiled(request: EngineRunRequest): OpenAiAgentsCompiled {
  const result = compileOpenAiAgentsRun(request);
  if (!result.ok) throw new Error(`expected a compile, got ${result.code}: ${result.reason}`);
  return result.compiled;
}

function refusal(request: EngineRunRequest): string {
  const result = compileOpenAiAgentsRun(request);
  if (result.ok) throw new Error('expected a refusal');
  return result.code;
}

describe('compileOpenAiAgentsRun', () => {
  describe('subagents', () => {
    const researcher = {
      name: 'researcher',
      description: 'Reads files and reports.',
      instructions: 'You only research.',
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    };
    const withSubagents = (
      subagents: NonNullable<EngineRunRequest['portable']['subagents']>,
      maxBudgetUsd: number | null = null,
    ): EngineRunRequest => ({
      ...BASE,
      portable: { ...BASE.portable, limits: { maxTurns: 7, maxBudgetUsd }, subagents },
    });

    it('compiles none to none', () => {
      expect(compiled(BASE).subagents).toEqual([]);
    });

    it('compiles each to its own tool set, on the parent model unless it names one', () => {
      const out = compiled(
        withSubagents([researcher, { ...researcher, name: 'writer', model: 'gpt-other' }]),
      );
      expect(out.subagents).toEqual([
        {
          name: 'researcher',
          toolName: 'subagent_researcher',
          description: 'Reads files and reports.',
          instructions: 'You only research.',
          model: 'gpt-test',
          tools: ['read_file', 'list_files', 'search_files'],
        },
        expect.objectContaining({ name: 'writer', model: 'gpt-other' }),
      ]);
    });

    it('refuses by name a subagent on another model when a budget cap is set', () => {
      const capped = withSubagents([{ ...researcher, model: 'gpt-other' }], 1);
      const result = compileOpenAiAgentsRun({
        ...capped,
        portable: { ...capped.portable, model: 'gpt-5' },
      });
      expect(result).toMatchObject({ ok: false, code: 'engine_capability_unsupported' });
      expect(result.ok ? '' : result.reason).toContain('"researcher"');
    });

    it('refuses by name two subagents whose tool names collide, or one too long', () => {
      for (const subagents of [
        [
          { ...researcher, name: 'Code Reviewer' },
          { ...researcher, name: 'Code_Reviewer' },
        ],
        [{ ...researcher, name: 'Code_Reviewer'.repeat(5) }],
      ]) {
        const result = compileOpenAiAgentsRun(withSubagents(subagents));
        expect(result).toMatchObject({ ok: false, code: 'engine_capability_unsupported' });
        expect(result.ok ? '' : result.reason).toContain(JSON.stringify(subagents.at(-1)?.name));
      }
    });
  });

  it('names the protocols it speaks and the one the connection is served over, in the kit wording', () => {
    const result = compileOpenAiAgentsRun({
      ...BASE,
      gateway: { ...BASE.gateway!, protocol: 'grpc' },
    });
    expect(result).toEqual({
      ok: false,
      code: 'engine_capability_unsupported',
      reason:
        'openai-agents speaks openai-responses, openai-chat-completions, anthropic-messages to the gateway; this run\'s connection is served over "grpc".',
    });
  });

  it('compiles every portable field', () => {
    const result = compiled(BASE);
    expect(result.agent).toEqual({
      name: 'Agent',
      instructions: 'Be brief.',
      model: 'gpt-test',
      tools: ['read_file', 'list_files', 'search_files', 'apply_patch', 'shell'],
      modelSettings: { reasoningEffort: 'low', parallelToolCalls: false },
    });
    expect(result.connection).toEqual({
      protocol: 'openai-responses',
      client: 'openai',
      endpoint: 'http://gateway.test/v1',
      authorization: 'Bearer tok',
    });
    expect(result.limits).toEqual({ maxTurns: 7, budget: null });
    expect(result.workspace.cwd).toBe('/workspace/run');
    expect(result.networkEgress).toBe(true);
    expect(result.tracingDisabled).toBe(true);
    expect(result.session).toEqual({
      mode: 'fresh',
      engineSessionId: 's-1',
      projectKey: 'tenant-a',
    });
  });

  it('turns each permission off by removing exactly its tools', () => {
    const off = (key: keyof EngineRunRequest['portable']['permissions']) =>
      compiled({
        ...BASE,
        portable: { ...BASE.portable, permissions: { ...BASE.portable.permissions, [key]: false } },
      });
    expect(off('readFiles').agent.tools).toEqual(['apply_patch', 'shell']);
    expect(off('writeFiles').agent.tools).toEqual([
      'read_file',
      'list_files',
      'search_files',
      'shell',
    ]);
    expect(off('runCommands').agent.tools).not.toContain('shell');
    expect(off('unrestrictedNetwork').networkEgress).toBe(false);
  });

  it('withholds shell under a read-only grant', () => {
    const result = compiled({
      ...BASE,
      resources: { files: [{ kind: 'file', path: 'a.md', access: 'read' }], skills: [] },
    });
    expect(result.agent.tools).not.toContain('shell');
    expect(result.agent.tools).toContain('apply_patch');
  });

  it('picks the client from the connection protocol', () => {
    const chat = compiled({
      ...BASE,
      gateway: { ...BASE.gateway!, protocol: 'openai-chat-completions' },
    });
    expect(chat.connection.client).toBe('openai');
    const anthropic = compiled({
      ...BASE,
      gateway: { ...BASE.gateway!, protocol: 'anthropic-messages' },
    });
    expect(anthropic.connection).toMatchObject({
      client: 'aisdk-anthropic',
      protocol: 'anthropic-messages',
    });
  });

  it('compiles stdio, http and sse connectors, with a deny policy as a blocked tool', () => {
    const result = compiled({
      ...BASE,
      portable: {
        ...BASE.portable,
        mcpServers: {
          local: { command: 'node', args: ['server.js'], env: { A: 'b' } },
          remote: {
            type: 'http',
            url: 'https://mcp.test/',
            headers: { authorization: 'Bearer c' },
            tools: [{ name: 'drop', permission_policy: 'always_deny' }],
          },
          stream: { type: 'sse', url: 'https://sse.test/' },
        },
      },
    });
    expect(result.mcpServers.map((server) => [server.name, server.transport])).toEqual([
      ['local', 'stdio'],
      ['remote', 'http'],
      ['stream', 'sse'],
    ]);
    expect(result.mcpServers[1]?.blockedTools).toEqual(['drop']);
  });

  it('offers no run_skill_script until skills are placed here: a script-shipping skill is refused', () => {
    expect(compiled(BASE).skillScript).toBeNull();
    const scripted: EngineRunRequest = {
      ...BASE,
      portable: { ...BASE.portable, skills: { mode: 'allowlist', names: ['support'] } },
      resources: {
        files: [],
        skills: [{ name: 'support', files: [{ path: 'scripts/a.mjs', contentBase64: 'eA==' }] }],
      },
    };
    expect(refusal(scripted)).toBe('engine_capability_unsupported');
  });

  it('refuses each unsupported requirement by its code', () => {
    expect(refusal({ ...BASE, policy: { tools: null } })).toBe('engine_policy_invalid');
    expect(
      refusal({ ...BASE, resources: { files: [], skills: [{ name: 'support', files: [] }] } }),
    ).toBe('engine_capability_unsupported');
    expect(
      refusal({
        ...BASE,
        portable: { ...BASE.portable, skills: { mode: 'allowlist', names: ['a'] } },
      }),
    ).toBe('engine_capability_unsupported');
    expect(refusal({ ...BASE, session: { mode: 'fork', engineSessionId: 'x' } })).toBe(
      'engine_capability_unsupported',
    );
    expect(refusal({ ...BASE, gateway: null })).toBe('engine_credential_refused');
    expect(refusal({ ...BASE, gateway: { ...BASE.gateway!, protocol: 'grpc' } })).toBe(
      'engine_capability_unsupported',
    );
    expect(
      refusal({
        ...BASE,
        portable: { ...BASE.portable, model: null },
        gateway: { ...BASE.gateway!, protocol: 'anthropic-messages' },
      }),
    ).toBe('engine_capability_unsupported');
    expect(refusal({ ...BASE, env: { ...BASE.env, ANTHROPIC_API_KEY: 'sk-real' } })).toBe(
      'engine_credential_refused',
    );
    expect(
      refusal({
        ...BASE,
        resources: {
          files: [{ kind: 'file', path: '.openai-agents/x', access: 'read' }],
          skills: [],
        },
      }),
    ).toBe('engine_policy_invalid');
    expect(
      refusal({
        ...BASE,
        portable: {
          ...BASE.portable,
          mcpServers: {
            ask: {
              type: 'http',
              url: 'https://a.test/',
              tools: [{ name: 't', permission_policy: 'always_ask' }],
            },
          },
        },
      }),
    ).toBe('engine_capability_unsupported');
    expect(
      refusal({
        ...BASE,
        portable: { ...BASE.portable, mcpServers: { bad: { type: 'ws', url: 'x' } } },
      }),
    ).toBe('engine_policy_invalid');
  });

  it('compiles a remote connector without unrestrictedNetwork, as the Claude engine does', () => {
    const result = compiled({
      ...BASE,
      portable: {
        ...BASE.portable,
        permissions: { ...BASE.portable.permissions, unrestrictedNetwork: false },
        mcpServers: {
          remote: { type: 'http', url: 'https://a.test/' },
          stream: { type: 'sse', url: 'https://s.test/' },
        },
      },
    });
    expect(result.networkEgress).toBe(false);
    expect(result.mcpServers.map((server) => [server.name, server.transport])).toEqual([
      ['remote', 'http'],
      ['stream', 'sse'],
    ]);
  });

  it('compiles a budget cap on a priced model with the rates it will be measured by', () => {
    const result = compiled({
      ...BASE,
      portable: { ...BASE.portable, model: 'gpt-5', limits: { maxTurns: null, maxBudgetUsd: 2.5 } },
    });
    expect(result.limits).toEqual({
      maxTurns: null,
      budget: {
        maxBudgetUsd: 2.5,
        model: 'gpt-5',
        price: {
          inputUsdPerMillion: '1.25',
          outputUsdPerMillion: '10',
          cachedInputUsdPerMillion: '0.125',
        },
      },
    });
    expect(compiled(BASE).limits.budget).toBeNull();
  });

  it('refuses a budget cap it cannot price, naming maxBudget and the model', () => {
    for (const model of ['gpt-test', null]) {
      const result = compileOpenAiAgentsRun({
        ...BASE,
        portable: { ...BASE.portable, model, limits: { maxTurns: null, maxBudgetUsd: 1 } },
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe('engine_capability_unsupported');
      expect(result.reason).toContain('maxBudget');
      if (model !== null) expect(result.reason).toContain(JSON.stringify(model));
    }
  });

  it('keys a resumed session by the engine session id it was handed', () => {
    expect(
      compiled({ ...BASE, session: { mode: 'resume', engineSessionId: 's-0' } }).session,
    ).toEqual({ mode: 'resume', engineSessionId: 's-0', projectKey: 'tenant-a' });
  });

  // S2-02f (#531), seam check 2: `MCPServerStreamableHttp` lists a tool by its bare name, so the
  // 41-character operation name is what the model sees; the server key only names the server.
  it('compiles a gateway tool connector entry as one http server named by its SD13 key', () => {
    const key = 'abcdefghijklmn_2';
    const url = 'http://gateway:4000/v1/tools/00000000-0000-4000-8000-00000000000a/mcp';
    const result = compiled({
      ...BASE,
      portable: {
        ...BASE.portable,
        mcpServers: {
          [key]: { type: 'http', url, headers: { authorization: 'Bearer run-token' } },
        },
      },
    });
    expect(result.mcpServers).toEqual([
      {
        name: key,
        transport: 'http',
        url,
        headers: { authorization: 'Bearer run-token' },
        timeoutMs: null,
        blockedTools: [],
      },
    ]);
  });
});
