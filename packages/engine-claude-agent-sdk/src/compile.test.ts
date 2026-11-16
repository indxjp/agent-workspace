import { describe, expect, it } from 'vitest';

import { RunRequest } from '@agent-workspace/run-protocol';

import {
  A11_IDENTITY_ENV_VARS,
  ANTHROPIC_API_KEY_ENV,
  PLATFORM_SETTING_SOURCES,
  PLATFORM_STRICT_MCP_CONFIG,
  SESSION_SCOPE_ENV_VARS,
  compileRunRequest,
} from './compile.js';
import {
  canonicalAgent,
  canonicalPolicy,
  canonicalRunRequest,
  compileCanonical,
  request,
} from './compile.test-support.js';
import { COMPILED_SDK_OPTION_KEYS_ARE_EXHAUSTIVE, compiledSdkOptionKeys } from './options.js';
import { CLAUDE_PRESET_TOOLS } from './tools.js';

describe('the compile step of spec §5', () => {
  it('emits only keys it declared, so the surface gate can check every one of them', () => {
    // `tests/sdk-surface.test.ts` checks `compiledSdkOptionKeys` against the installed SDK. A
    // key the compiler emits but does not declare would never be checked, so assert the
    // containment here rather than trusting it.
    expect(COMPILED_SDK_OPTION_KEYS_ARE_EXHAUSTIVE).toBe(true);
    const emitted = Object.keys(compileRunRequest(request));
    expect(
      emitted.filter((key) => !(compiledSdkOptionKeys as readonly string[]).includes(key)),
    ).toEqual([]);
  });

  it('compiles the canonical request into the options §5 sketches', () => {
    const options = compileRunRequest(request);
    expect(options.cwd).toBe('/run/claude');
    expect(options.model).toBe('claude-sonnet-4-5');
    expect(options.maxTurns).toBe(20);
    expect(options.maxBudgetUsd).toBe(5);
    expect(options.mcpServers).toEqual(canonicalAgent.mcpServers);
    expect(options.settingSources).toEqual(PLATFORM_SETTING_SOURCES);
    expect(options.settingSources).toContain('project');
    expect(options.strictMcpConfig).toBe(PLATFORM_STRICT_MCP_CONFIG);
    expect(options.strictMcpConfig).toBe(true);
  });
});

describe('the compile step of spec §5: tool lists', () => {
  it('maps the three tool lists separately, because allowedTools does not restrict', () => {
    const options = compileRunRequest(request);
    // The stored arm's own lists, plus the permission floor this agent's two `false` switches
    // produce, plus the `mcp__<server>__*` approval each assigned connector earns — in that order.
    expect(options.allowedTools).toEqual([
      ...canonicalPolicy.tools.autoApprove,
      'mcp__jira__*',
      'mcp__search__*',
    ]);
    expect(options.disallowedTools).toEqual([
      ...canonicalPolicy.tools.deny,
      'BashOutput',
      'KillShell',
      'WebFetch',
      'WebSearch',
    ]);
    expect(options.tools).toEqual(canonicalPolicy.tools.base);
    expect(options.permissionMode).toBe('dontAsk');
    // Not set unless the mode is bypassPermissions — and the schema will not let it be.
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
  });
});

describe('the compile step of spec §5: the preset base becomes an allow-list', () => {
  it("maps 'claude_code_preset' onto an allow-list, never the SDK's whole preset (BH061-010)", () => {
    const options = compileCanonical({
      policy: {
        ...canonicalPolicy,
        tools: { ...canonicalPolicy.tools, base: 'claude_code_preset' },
      },
    });
    expect(options.tools).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Write',
      'Edit',
      'NotebookEdit',
      'Bash',
      'BashOutput',
      'KillShell',
      'WebFetch',
      'WebSearch',
      'Skill',
      'TodoWrite',
      'ToolSearch',
      'ListMcpResourcesTool',
      'ReadMcpResourceTool',
    ]);
  });

  it('offers an agent with every permission off no privileged built-in tool (BH061-010)', () => {
    const options = compileCanonical({
      portable: {
        ...canonicalAgent,
        permissions: {
          readFiles: false,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      },
      policy: {
        ...canonicalPolicy,
        tools: { ...canonicalPolicy.tools, base: 'claude_code_preset' },
      },
    });
    expect(options.tools).toEqual(CLAUDE_PRESET_TOOLS);
    const usable = CLAUDE_PRESET_TOOLS.filter((tool) => !options.disallowedTools.includes(tool));
    expect(usable).toEqual([
      'Skill',
      'TodoWrite',
      'ToolSearch',
      'ListMcpResourcesTool',
      'ReadMcpResourceTool',
    ]);
  });
});

describe('the compile step of spec §5: skills, instructions and limits', () => {
  it('carries the skill policy onto the skills option', () => {
    expect(compileRunRequest(request).skills).toEqual(['customer-support']);
    const all = compileCanonical({
      portable: { ...canonicalAgent, skills: { mode: 'all' } },
    });
    expect(all.skills).toBe('all');
    const none = compileCanonical({
      portable: { ...canonicalAgent, skills: { mode: 'allowlist', names: [] } },
    });
    expect(none.skills).toEqual([]);
  });

  it('appends the agent instructions to the Claude Code preset rather than replacing it', () => {
    expect(compileRunRequest(request).systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: canonicalAgent.instructions,
    });
  });

  it('emits no systemPrompt at all when the instructions field is empty', () => {
    const options = compileCanonical({
      portable: { ...canonicalAgent, instructions: '   ' },
    });
    expect('systemPrompt' in options).toBe(false);
  });

  it('omits model and the limits rather than sending a null the SDK would reject', () => {
    const options = compileCanonical({
      portable: {
        ...canonicalAgent,
        model: null,
        limits: { maxTurns: null, maxBudgetUsd: null },
      },
    });
    expect('model' in options).toBe(false);
    expect('maxTurns' in options).toBe(false);
    expect('maxBudgetUsd' in options).toBe(false);
  });
});

describe('the session scope reaches the subprocess as env, and only from one place', () => {
  it('derives both scope variables and both A.11 identity variables from the request', () => {
    const options = compileRunRequest(request);
    expect(options.env).toEqual({
      ENABLE_TOOL_SEARCH: 'false',
      PATH: '/usr/bin',
      HOME: '/home/agent',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CONFIG_DIR: '/run/claude/.claude',
      CLAUDE_CODE_PROJECT_DIR_NAME: 'tenant-a',
      AGENT_WORKSPACE_RUN_ID: canonicalRunRequest.runId,
      AGENT_WORKSPACE_SESSION_ID: canonicalRunRequest.sessionId,
    });
    // Every key this test just asserted a value for is accounted for by the two exported
    // "derived, never copied" lists — so a third list added later without extending one of
    // these would be caught by `toEqual` above rather than only by this membership check.
    for (const key of [...SESSION_SCOPE_ENV_VARS, ...A11_IDENTITY_ENV_VARS]) {
      expect(key in options.env).toBe(true);
    }
  });

  it('always compiles the three quiet flags to 1, whatever the request env says (D-13)', () => {
    const quiet = [
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'DISABLE_TELEMETRY',
      'DISABLE_ERROR_REPORTING',
    ];
    const omitted = compileRunRequest(request);
    const disabled = compileCanonical({
      env: {
        ...canonicalRunRequest.env,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '',
        DISABLE_TELEMETRY: '',
        DISABLE_ERROR_REPORTING: '',
      },
    });
    const zeroed = compileCanonical({
      env: { ...canonicalRunRequest.env, DISABLE_TELEMETRY: '0' },
    });
    for (const options of [omitted, disabled, zeroed]) {
      for (const key of quiet) expect(options.env[key]).toBe('1');
    }
  });
});

describe('the session scope: reserved variables and refusals', () => {
  it('refuses reserved variables case-insensitively for Windows environment semantics', () => {
    for (const reserved of [
      'CLAUDE_CONFIG_DIR',
      'claude_config_dir',
      'CLAUDE_CODE_PROJECT_DIR_NAME',
      'claude_code_project_dir_name',
      'agent_workspace_run_id',
      'Agent_Workspace_Session_Id',
    ]) {
      expect(() =>
        compileCanonical({
          env: { ...canonicalRunRequest.env, [reserved]: '/somewhere/else' },
        }),
      ).toThrow();
    }
  });
});

describe('the session scope: identity variables and environment refusals', () => {
  it("derives AGENT_WORKSPACE_RUN_ID / AGENT_WORKSPACE_SESSION_ID from this request's own ids, not from env", () => {
    const otherRunId = '11111111-1111-4111-8111-111111111111';
    const otherSessionId = '22222222-2222-4222-8222-222222222222';
    const options = compileCanonical({ runId: otherRunId, sessionId: otherSessionId });
    expect(options.env['AGENT_WORKSPACE_RUN_ID']).toBe(otherRunId);
    expect(options.env['AGENT_WORKSPACE_SESSION_ID']).toBe(otherSessionId);
  });

  it('refuses to compile a run whose environment carries the provider master credential (spec A.11)', () => {
    for (const name of [ANTHROPIC_API_KEY_ENV, 'anthropic_api_key', 'Anthropic_Api_Key']) {
      expect(() =>
        compileCanonical({
          env: { ...canonicalRunRequest.env, [name]: 'sk-ant-stolen' },
        }),
      ).toThrow(/ANTHROPIC_API_KEY|provider master credentials/u);
    }
  });

  it('refuses duplicate environment keys that differ only by case', () => {
    expect(() =>
      compileRunRequest({
        ...request,
        env: { ...canonicalRunRequest.env, SERVICE_TOKEN: 'one', service_token: 'two' },
      }),
    ).toThrow(/case-insensitive|case-insensitively/u);
  });

  it('rejects an own __proto__ environment key instead of silently dropping it', () => {
    const special = JSON.parse('{"__proto__":"safe-value"}') as Record<string, string>;
    expect(() =>
      compileRunRequest({
        ...request,
        env: { ...canonicalRunRequest.env, ...special },
      }),
    ).toThrow(/__proto__/u);
  });

  it('refuses to compile a run whose tenant key the SDK would silently ignore', () => {
    // Not a warning and not a fallback: the run does not start. Both of the SDK's failure modes
    // here are silent, so this is the last place the collision can be caught (R-01 §7).
    expect(() => compileRunRequest({ ...request, projectKey: 'tenant a' })).toThrow();
    expect(() => compileRunRequest({ ...request, projectKey: '' })).toThrow();
    // A reserved Windows device name is ignored just as silently (R-01 §7 rule 2).
    expect(() => compileRunRequest({ ...request, projectKey: 'con' })).toThrow();
  });

  it('re-parses its argument, so a value that never went through the schema cannot slip past', () => {
    // The argument is typed `RunRequest`, but the value at run time came from a row, a body or
    // a queue message. A cast is not a check.
    expect(() => compileRunRequest({ ...request, cwd: '' })).toThrow();
  });
});

describe('the three session modes are the three legal option combinations (R-01 §6)', () => {
  it('a fresh run passes our own minted sessionId and no resume', () => {
    const options = compileRunRequest(request);
    expect(options.sessionId).toBe(canonicalRunRequest.session.sessionId);
    expect('resume' in options).toBe(false);
    expect('forkSession' in options).toBe(false);
  });

  it('a resume passes resume alone', () => {
    const options = compileCanonical({
      session: { kind: 'resume', resume: canonicalRunRequest.session.sessionId },
    });
    expect(options.resume).toBe(canonicalRunRequest.session.sessionId);
    expect('sessionId' in options).toBe(false);
    expect('forkSession' in options).toBe(false);
  });

  it('a fork is the only shape that carries both, and it sets forkSession', () => {
    const options = compileCanonical({
      session: {
        kind: 'fork',
        resume: canonicalRunRequest.session.sessionId,
        sessionId: canonicalRunRequest.sessionId,
      },
    });
    expect(options.resume).toBe(canonicalRunRequest.session.sessionId);
    expect(options.sessionId).toBe(canonicalRunRequest.sessionId);
    expect(options.forkSession).toBe(true);
  });
});

// S2-02f (#531), seam check 2: a gateway tool connector arrives as an `http` MCP server keyed by
// its SD13 short key, with the run token as its only header.
describe('a gateway tool connector entry', () => {
  const key = 'abcdefghijklmn_2';
  const entry = {
    type: 'http',
    url: 'http://gateway:4000/v1/tools/00000000-0000-4000-8000-00000000000a/mcp',
    headers: { authorization: 'Bearer run-token' },
  } as const;
  const gatewayRequest = RunRequest.parse({
    ...canonicalRunRequest,
    portable: { ...canonicalAgent, mcpServers: { [key]: entry } },
    policy: { tools: null, fileGrantDeny: [] },
  });

  it('compiles verbatim and is approved as mcp__<key>__*, whose longest name is 64', () => {
    const options = compileRunRequest(gatewayRequest);
    expect(options.mcpServers).toEqual({ [key]: entry });
    expect(options.allowedTools).toContain(`mcp__${key}__*`);
    expect(`mcp__${key}__${'a'.repeat(41)}`).toHaveLength(64);
  });
});

// #974 (ADR-0133 D14): a subagent compiles to an `agents` entry the model reaches through `Agent`.
