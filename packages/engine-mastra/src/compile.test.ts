/**
 * `compileMastraRun`: every portable field, and every refusal by its code (ENG-10, #309).
 */
import type { EngineRunRequest } from '@agent-workspace/engine';
import { describe, expect, it } from 'vitest';

import {
  compileMastraRun,
  MASTRA_DEFAULT_MODELS,
  MASTRA_MEMORY_LAST_MESSAGES,
  mastraModelConnection,
  type MastraCompiled,
} from './compile.js';
import { mastraToolKind } from './tools.js';

const SESSION = '7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6';

function request(overrides: Partial<EngineRunRequest> = {}): EngineRunRequest {
  return {
    runId: 'run-1',
    sessionId: SESSION,
    projectKey: 'tenant',
    cwd: '/workspace/tenant/',
    prompt: 'go',
    engine: 'mastra',
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
      skills: { mode: 'allowlist', names: ['writer', 'writer'] },
      mcpServers: {},
      limits: { maxTurns: 7, maxBudgetUsd: null },
    },
    policy: { toolCallConcurrency: 3 },
    session: { mode: 'fresh' },
    gateway: {
      baseUrl: 'https://gateway.test/',
      token: 'run-token',
      protocol: 'anthropic-messages',
    },
    resources: {
      files: [{ kind: 'file', path: 'notes.md', access: 'read-write' }],
      skills: [
        { name: 'writer', files: [] },
        { name: 'reviewer', files: [] },
      ],
    },
    env: { PATH: '/usr/bin', HOME: '/workspace/tenant' },
    ...overrides,
  };
}

function compiled(overrides: Partial<EngineRunRequest> = {}): MastraCompiled {
  const result = compileMastraRun(request(overrides));
  if (!result.ok) throw new Error(result.reason);
  return result.compiled;
}

function refusal(overrides: Partial<EngineRunRequest>): { code: string; reason: string } {
  const result = compileMastraRun(request(overrides));
  if (result.ok) throw new Error('expected a refusal');
  return { code: result.code, reason: result.reason };
}

const portable = request().portable;

describe('compileMastraRun', () => {
  it('copies an outputSchema verbatim, and compiles none to null (ADR-0143)', () => {
    const schema = { type: 'object', properties: { verdict: { type: 'string' } } };
    expect(compiled({ outputSchema: schema }).outputSchema).toEqual(schema);
    expect(compiled().outputSchema).toBeNull();
  });

  it('compiles every portable field', () => {
    const out = compiled();
    expect(out.agent).toEqual({
      name: 'Writer',
      instructions: 'Write clearly.',
      model: 'claude-sonnet-4-5',
      tools: [
        'mastra_workspace_read_file',
        'mastra_workspace_list_files',
        'mastra_workspace_grep',
        'mastra_workspace_file_stat',
        'mastra_workspace_write_file',
        'mastra_workspace_edit_file',
        'mastra_workspace_mkdir',
        'mastra_workspace_delete',
        'mastra_workspace_execute_command',
        'mastra_workspace_get_process_output',
        'mastra_workspace_kill_process',
      ],
      skillTools: true,
      toolCallConcurrency: 3,
    });
    expect(out.networkEgress).toBe(true);
    expect(out.limits).toEqual({ maxSteps: 7, budget: null });
    expect(out.workspace).toEqual({
      cwd: '/workspace/tenant',
      grants: [{ kind: 'file', path: 'notes.md', access: 'read-write', segments: ['notes.md'] }],
      protectedDirectory: '.mastra',
    });
    expect(out.skills).toEqual({ directory: '.mastra/skills', names: ['writer'] });
    expect(out.env).toEqual({ PATH: '/usr/bin', HOME: '/workspace/tenant' });
    expect(out.mcpServers).toEqual([]);
  });

  it('keeps memory on the platform thread with every model-calling feature off', () => {
    expect(compiled().memory).toEqual({
      mode: 'fresh',
      threadId: SESSION,
      resourceId: 'tenant',
      projectKey: 'tenant',
      lastMessages: MASTRA_MEMORY_LAST_MESSAGES,
      semanticRecall: false,
      workingMemory: false,
      generateTitle: false,
    });
    expect(
      compiled({ session: { mode: 'resume', engineSessionId: 'thread-earlier' } }).memory,
    ).toMatchObject({ mode: 'resume', threadId: 'thread-earlier' });
  });

  it('turns telemetry and every observability exporter off, whatever the request says', () => {
    expect(compiled().observability).toEqual({ telemetry: false, exporters: [] });
    expect(compiled({ policy: {} }).observability).toEqual({ telemetry: false, exporters: [] });
  });

  it('points every protocol at the gateway /v1 with the run token as the bearer', () => {
    for (const [protocol, api] of [
      ['anthropic-messages', 'anthropic.messages'],
      ['openai-responses', 'openai.responses'],
      ['openai-chat-completions', 'openai.chat'],
    ] as const) {
      const out = compiled({
        gateway: { baseUrl: 'https://gateway.test//', token: 'tok', protocol },
      });
      expect(out.connection).toEqual({
        protocol,
        api,
        baseUrl: 'https://gateway.test/v1',
        token: 'tok',
        authorization: 'Bearer tok',
      });
    }
    expect(
      mastraModelConnection({ baseUrl: 'http://g', token: 'x' }, 'openai-responses').baseUrl,
    ).toBe('http://g/v1');
  });

  it("names the adapter's default model for a run that names none, per protocol family", () => {
    const none = { ...portable, model: null };
    expect(compiled({ portable: none }).agent.model).toBe(MASTRA_DEFAULT_MODELS.anthropic);
    expect(
      compiled({
        portable: none,
        gateway: { baseUrl: 'https://g', token: 't', protocol: 'openai-chat-completions' },
      }).agent.model,
    ).toBe(MASTRA_DEFAULT_MODELS.openai);
  });

  it('prices a cap with the provisional table, and refuses a cap it cannot price', () => {
    const capped = compiled({
      portable: { ...portable, limits: { maxTurns: null, maxBudgetUsd: 2 } },
    });
    expect(capped.limits.budget).toMatchObject({ maxBudgetUsd: 2, model: 'claude-sonnet-4-5' });
    expect(
      refusal({
        portable: {
          ...portable,
          model: 'unpriced-model',
          limits: { maxTurns: null, maxBudgetUsd: 2 },
        },
      }),
    ).toMatchObject({ code: 'engine_capability_unsupported' });
  });

  it('withholds the command tools under a read-only grant, and follows each switch', () => {
    const readOnly = compiled({
      resources: { files: [{ kind: 'file', path: 'contract.pdf', access: 'read' }], skills: [] },
    });
    expect(readOnly.agent.tools.some((tool) => tool.includes('command'))).toBe(false);
    expect(readOnly.agent.tools).toContain('mastra_workspace_write_file');
    const nothing = compiled({
      portable: {
        ...portable,
        permissions: {
          readFiles: false,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
        skills: { mode: 'allowlist', names: [] },
      },
    });
    expect(nothing.agent).toMatchObject({ tools: [], skillTools: false });
    expect(nothing.networkEgress).toBe(false);
  });

  it('offers run_skill_script for a granted skill that ships a script, and keeps the command tools withheld', () => {
    const scripted = {
      files: [{ kind: 'directory', path: 'contracts', access: 'read' }],
      skills: [{ name: 'writer', files: [{ path: 'scripts/a.mjs', contentBase64: 'eA==' }] }],
    } as const;
    const out = compiled({ resources: scripted });
    expect(out.skillScript).toEqual({
      cwd: '/workspace/tenant',
      skillsDirectory: '.mastra/skills',
      skills: [{ name: 'writer', scripts: ['a.mjs'] }],
      writable: ['outputs'],
    });
    expect(out.agent.tools.some((tool) => tool.includes('command'))).toBe(false);
    expect(compiled().skillScript).toBeNull();
    const off = compiled({
      resources: scripted,
      portable: { ...portable, permissions: { ...portable.permissions, runCommands: false } },
    });
    expect(off.skillScript).toBeNull();
  });

  it('compiles connectors into MCPClient servers, in name order, blocked tools listed', () => {
    const out = compiled({
      portable: {
        ...portable,
        mcpServers: {
          search: {
            type: 'sse',
            url: 'https://mcp.example.com/sse',
            headers: { 'x-tenant': 'a' },
            tools: [{ name: 'purge', permission_policy: 'always_deny' }],
          },
          files: {
            command: 'mcp-files',
            args: ['--root', '.'],
            env: { MODE: 'ro' },
            timeout: 5000,
          },
        },
      },
    });
    expect(out.mcpServers).toEqual([
      {
        name: 'files',
        transport: 'stdio',
        command: 'mcp-files',
        args: ['--root', '.'],
        env: { PATH: '/usr/bin', HOME: '/workspace/tenant', MODE: 'ro' },
        timeoutMs: 5000,
        blockedTools: [],
      },
      {
        name: 'search',
        transport: 'http',
        url: 'https://mcp.example.com/sse',
        headers: { 'x-tenant': 'a' },
        timeoutMs: null,
        blockedTools: ['purge'],
      },
    ]);
  });

  it.each([
    ['an unreadable arm', { policy: { toolCallConcurrency: 0 } }, 'engine_policy_invalid'],
    ['an unknown arm key', { policy: { thinkingLevel: 'high' } }, 'engine_policy_invalid'],
    [
      'a grant in the adapter directory',
      {
        resources: { files: [{ kind: 'file', path: '.mastra/x', access: 'read' }], skills: [] },
      },
      'engine_policy_invalid',
    ],
    [
      'a fork',
      { session: { mode: 'fork', engineSessionId: 'parent' } },
      'engine_capability_unsupported',
    ],
    [
      'a protocol it does not speak',
      {
        gateway: { baseUrl: 'https://g', token: 't', protocol: 'gemini-generate-content' },
      },
      'engine_capability_unsupported',
    ],
    ['no gateway connection', { gateway: null }, 'engine_credential_refused'],
    [
      'a database URL in the environment',
      { env: { DATABASE_URL: 'postgres://x' } },
      'engine_credential_refused',
    ],
    [
      'a libpq password in the environment',
      { env: { pgpassword: 'x' } },
      'engine_credential_refused',
    ],
    [
      'a LibSQL token in the environment',
      { env: { LIBSQL_AUTH: 'x' } },
      'engine_credential_refused',
    ],
    [
      'a provider credential in the environment',
      {
        env: { ANTHROPIC_API_KEY: 'sk-ant-real' },
      },
      'engine_credential_refused',
    ],
  ] as const)('refuses %s', (_name, overrides, code) => {
    expect(refusal(overrides as Partial<EngineRunRequest>).code).toBe(code);
  });

  it('refuses a fork in the kit wording', () => {
    expect(refusal({ session: { mode: 'fork', engineSessionId: 'parent' } })).toEqual({
      code: 'engine_capability_unsupported',
      reason: 'mastra declares fork: false, so a session cannot be branched on this engine.',
    });
  });

  it('refuses an unreadable connector and one that asks for an approval, by name', () => {
    expect(
      refusal({ portable: { ...portable, mcpServers: { docs: { type: 'ws', url: 'x' } } } }),
    ).toMatchObject({
      code: 'engine_policy_invalid',
      reason: expect.stringContaining('"docs"') as unknown,
    });
    expect(
      refusal({
        portable: {
          ...portable,
          mcpServers: {
            docs: {
              type: 'http',
              url: 'https://mcp.example.com/mcp',
              tools: [{ name: 'publish', permission_policy: 'always_ask' }],
            },
          },
        },
      }),
    ).toMatchObject({
      code: 'engine_capability_unsupported',
      reason: expect.stringContaining('publish') as unknown,
    });
  });

  // S2-02f (#531), seam check 2: Mastra's `MCPClient.listTools()` shows the model
  // `<server>_<tool>`, so the SD13 key's 16 characters and the 41-character name make 58.
  it('compiles a gateway tool connector entry, whose model-visible name is <key>_<tool>', () => {
    const key = 'abcdefghijklmn_2';
    const url = 'http://gateway:4000/v1/tools/00000000-0000-4000-8000-00000000000a/mcp';
    const out = compiled({
      portable: {
        ...portable,
        mcpServers: {
          [key]: { type: 'http', url, headers: { authorization: 'Bearer run-token' } },
        },
      },
    });
    expect(out.mcpServers).toEqual([
      {
        name: key,
        transport: 'http',
        url,
        headers: { authorization: 'Bearer run-token' },
        timeoutMs: null,
        blockedTools: [],
      },
    ]);
    // `MCPClient`'s `allowedHosts` is the url's host (`boundary.ts`): the gateway, nothing else.
    expect(new URL(url).host).toBe('gateway:4000');
    const visible = `${key}_${'a'.repeat(41)}`;
    expect(visible).toHaveLength(58);
    expect(mastraToolKind(visible, [key])).toBe('mcp');
  });

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

    it('compiles none to none', () => {
      expect(compiled().subagents).toEqual([]);
    });

    it('compiles each to its own tool set, on the parent model unless it names one', () => {
      const out = compiled({
        portable: {
          ...portable,
          subagents: [researcher, { ...researcher, name: 'writer', model: 'claude-opus-4-5' }],
        },
      });
      expect(out.subagents).toEqual([
        {
          name: 'researcher',
          toolName: 'agent-researcher',
          description: 'Reads files and reports.',
          instructions: 'You only research.',
          model: 'claude-sonnet-4-5',
          tools: [
            'mastra_workspace_read_file',
            'mastra_workspace_list_files',
            'mastra_workspace_grep',
            'mastra_workspace_file_stat',
          ],
        },
        expect.objectContaining({ name: 'writer', model: 'claude-opus-4-5' }),
      ]);
    });

    it('refuses by name a subagent on another model when a budget cap is set', () => {
      const result = refusal({
        portable: {
          ...portable,
          limits: { maxTurns: null, maxBudgetUsd: 1 },
          subagents: [{ ...researcher, model: 'claude-opus-4-5' }],
        },
      });
      expect(result.code).toBe('engine_capability_unsupported');
      expect(result.reason).toContain('"researcher"');
    });

    it('refuses by name two subagents whose tool names collide, or one too long', () => {
      for (const subagents of [
        [
          { ...researcher, name: 'Code Reviewer' },
          { ...researcher, name: 'Code_Reviewer' },
        ],
        [{ ...researcher, name: 'Code_Reviewer'.repeat(5) }],
      ]) {
        const result = refusal({ portable: { ...portable, subagents } });
        expect(result.code).toBe('engine_capability_unsupported');
        expect(result.reason).toContain(JSON.stringify(subagents.at(-1)?.name));
      }
    });
  });

  it('is pure: two compiles of one request are equal and JSON round-trips', () => {
    const first = compiled();
    expect(compiled()).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });
});
