import { describe, expect, it } from 'vitest';

import { RunRequest } from '@agent-workspace/run-protocol';
import { AGENT_TOOL_PERMISSION_MODES } from '@indx-workspace/contracts/agents';

import {
  A11_IDENTITY_ENV_VARS,
  ANTHROPIC_API_KEY_ENV,
  PLATFORM_SETTING_SOURCES,
  PLATFORM_STRICT_MCP_CONFIG,
  SESSION_SCOPE_ENV_VARS,
  SubagentToolRemovedError,
  compileRunRequest,
} from './compile.js';
import { COMPILED_SDK_OPTION_KEYS_ARE_EXHAUSTIVE, compiledSdkOptionKeys } from './options.js';
import { CLAUDE_PRESET_TOOLS } from './tools.js';

/**
 * The canonical fixtures, restated here rather than imported from `schemas.test.ts`.
 *
 * Importing one test module from another executes its `describe` blocks a second time, so every
 * assertion in `schemas.test.ts` would be collected and run twice — once under its own name and
 * once under this file's. A duplicated test is not a stronger test; it is a slower run and a
 * confusing report. Two explicit fixtures cost twenty lines and keep each file self-contained.
 */
const canonicalAgent = {
  name: 'Customer Support Agent',
  instructions: 'You help employees answer questions...',
  model: 'claude-sonnet-4-5',
  permissions: {
    readFiles: true,
    writeFiles: true,
    runCommands: false,
    unrestrictedNetwork: false,
  },
  skills: { mode: 'allowlist', names: ['customer-support'] },
  mcpServers: {
    jira: {
      type: 'http',
      url: 'https://jira.example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    },
    search: { command: '/usr/bin/search-mcp', args: ['--stdio'] },
  },
  limits: { maxTurns: 20, maxBudgetUsd: 5 },
} as const;

/** The engine arm as compose composes it for an agent with a stored policy. */
const canonicalPolicy = {
  tools: {
    base: ['Read', 'Grep', 'mcp__jira__get_issue'],
    autoApprove: ['Read', 'mcp__jira__get_*'],
    deny: ['Bash', 'mcp__*'],
    permissionMode: 'dontAsk',
    allowDangerouslySkipPermissions: false,
  },
  fileGrantDeny: [],
} as const;

const canonicalRunRequest = {
  runId: '6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b',
  sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
  cwd: '/run/claude',
  prompt: 'Summarise the open Jira issues.',
  projectKey: 'tenant-a',
  portable: canonicalAgent,
  policy: canonicalPolicy,
  session: { kind: 'fresh', sessionId: 'c101d922-3c4b-4a12-9b1e-0a1b2c3d4e5f' },
  env: { PATH: '/usr/bin', HOME: '/home/agent' },
} as const;

const request = RunRequest.parse(canonicalRunRequest);

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

  it("maps 'claude_code_preset' onto an allow-list, never the SDK's whole preset (BH061-010)", () => {
    const options = compileRunRequest(
      RunRequest.parse({
        ...canonicalRunRequest,
        policy: {
          ...canonicalPolicy,
          tools: { ...canonicalPolicy.tools, base: 'claude_code_preset' },
        },
      }),
    );
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
    const options = compileRunRequest(
      RunRequest.parse({
        ...canonicalRunRequest,
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
      }),
    );
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

  it('carries the skill policy onto the skills option', () => {
    expect(compileRunRequest(request).skills).toEqual(['customer-support']);
    const all = compileRunRequest(
      RunRequest.parse({
        ...canonicalRunRequest,
        portable: { ...canonicalAgent, skills: { mode: 'all' } },
      }),
    );
    expect(all.skills).toBe('all');
    const none = compileRunRequest(
      RunRequest.parse({
        ...canonicalRunRequest,
        portable: { ...canonicalAgent, skills: { mode: 'allowlist', names: [] } },
      }),
    );
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
    const options = compileRunRequest(
      RunRequest.parse({
        ...canonicalRunRequest,
        portable: { ...canonicalAgent, instructions: '   ' },
      }),
    );
    expect('systemPrompt' in options).toBe(false);
  });

  it('omits model and the limits rather than sending a null the SDK would reject', () => {
    const options = compileRunRequest(
      RunRequest.parse({
        ...canonicalRunRequest,
        portable: {
          ...canonicalAgent,
          model: null,
          limits: { maxTurns: null, maxBudgetUsd: null },
        },
      }),
    );
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
        compileRunRequest(
          RunRequest.parse({
            ...canonicalRunRequest,
            env: { ...canonicalRunRequest.env, [reserved]: '/somewhere/else' },
          }),
        ),
      ).toThrow();
    }
  });

  it("derives AGENT_WORKSPACE_RUN_ID / AGENT_WORKSPACE_SESSION_ID from this request's own ids, not from env", () => {
    const otherRunId = '11111111-1111-4111-8111-111111111111';
    const otherSessionId = '22222222-2222-4222-8222-222222222222';
    const options = compileRunRequest(
      RunRequest.parse({ ...canonicalRunRequest, runId: otherRunId, sessionId: otherSessionId }),
    );
    expect(options.env['AGENT_WORKSPACE_RUN_ID']).toBe(otherRunId);
    expect(options.env['AGENT_WORKSPACE_SESSION_ID']).toBe(otherSessionId);
  });

  it('refuses to compile a run whose environment carries the provider master credential (spec A.11)', () => {
    for (const name of [ANTHROPIC_API_KEY_ENV, 'anthropic_api_key', 'Anthropic_Api_Key']) {
      expect(() =>
        compileRunRequest(
          RunRequest.parse({
            ...canonicalRunRequest,
            env: { ...canonicalRunRequest.env, [name]: 'sk-ant-stolen' },
          }),
        ),
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
    const options = compileRunRequest(
      RunRequest.parse({
        ...canonicalRunRequest,
        session: { kind: 'resume', resume: canonicalRunRequest.session.sessionId },
      }),
    );
    expect(options.resume).toBe(canonicalRunRequest.session.sessionId);
    expect('sessionId' in options).toBe(false);
    expect('forkSession' in options).toBe(false);
  });

  it('a fork is the only shape that carries both, and it sets forkSession', () => {
    const options = compileRunRequest(
      RunRequest.parse({
        ...canonicalRunRequest,
        session: {
          kind: 'fork',
          resume: canonicalRunRequest.session.sessionId,
          sessionId: canonicalRunRequest.sessionId,
        },
      }),
    );
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
describe('subagents', () => {
  const subagent = {
    name: 'billing-specialist',
    description: 'Answers billing questions.',
    instructions: 'You answer billing questions.',
    model: 'claude-haiku-4-5',
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: true,
    },
  } as const;
  const withSubagents = (policy: unknown, subagents: readonly unknown[] = [subagent]) =>
    RunRequest.parse({
      ...canonicalRunRequest,
      portable: { ...canonicalAgent, subagents },
      policy,
    });
  const preset = { tools: null, fileGrantDeny: [] };

  it('emits no agents key without subagents', () => {
    expect('agents' in compileRunRequest(request)).toBe(false);
  });

  it('maps a subagent to an agents entry, denying only what its permissions add to the parent', () => {
    const options = compileRunRequest(withSubagents(preset));
    expect(options.disallowedTools).toContain('Bash');
    expect(options.agents).toEqual({
      'billing-specialist': {
        description: 'Answers billing questions.',
        prompt: 'You answer billing questions.',
        model: 'claude-haiku-4-5',
        disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
      },
    });
  });

  it('leaves model and disallowedTools out when the subagent sets none', () => {
    const open = {
      readFiles: true,
      writeFiles: true,
      runCommands: true,
      unrestrictedNetwork: true,
    };
    const parentOpen = RunRequest.parse({
      ...canonicalRunRequest,
      portable: {
        ...canonicalAgent,
        permissions: open,
        subagents: [{ ...subagent, model: null, permissions: open }],
      },
      policy: preset,
    });
    expect(compileRunRequest(parentOpen).agents).toEqual({
      'billing-specialist': {
        description: 'Answers billing questions.',
        prompt: 'You answer billing questions.',
      },
    });
  });

  it('throws the typed error when the tool policy removes Agent', () => {
    const denied = { tools: { ...canonicalPolicy.tools, deny: ['Agent'] }, fileGrantDeny: [] };
    expect(() => compileRunRequest(withSubagents(denied))).toThrow(SubagentToolRemovedError);
    expect(() => compileRunRequest(withSubagents(canonicalPolicy))).toThrow(
      SubagentToolRemovedError,
    );
    expect(() => compileRunRequest(withSubagents(canonicalPolicy, []))).not.toThrow();
  });
});

describe('handoff (ADR-0145 D4)', () => {
  const compileWith = (handoff: boolean): ReturnType<typeof compileRunRequest> =>
    compileRunRequest(
      RunRequest.parse({ ...canonicalRunRequest, policy: { tools: null, handoff } }),
    );

  it('auto-approves handoff_to_person and carries the flag only when on', () => {
    const on = compileWith(true);
    expect(on.allowedTools).toContain('mcp__agent-workspace__handoff_to_person');
    expect(on.handoff).toBe(true);
    const off = compileWith(false);
    expect(off.allowedTools).not.toContain('mcp__agent-workspace__handoff_to_person');
    expect('handoff' in off).toBe(false);
  });
});

describe('requireApproval (ADR-0145)', () => {
  const withTools = (
    tools: Record<string, unknown>,
    policy: Record<string, unknown>,
  ): ReturnType<typeof compileRunRequest> =>
    compileRunRequest(RunRequest.parse({ ...canonicalRunRequest, policy: { tools, ...policy } }));
  const defaultTools = {
    base: ['Read', 'mcp__gh__push'],
    autoApprove: ['Read', 'mcp__gh__*'],
    deny: [],
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
  };

  it('carries no gate without requireApproval, so existing compiles are unchanged', () => {
    const compiled = withTools(defaultTools, {});
    expect('approval' in compiled).toBe(false);
    expect(compiled.allowedTools).toEqual(['Read', 'mcp__gh__*', 'mcp__jira__*', 'mcp__search__*']);
  });

  it('moves rules that could approve a gated tool out of allowedTools and into the gate', () => {
    const compiled = withTools(defaultTools, {
      requireApproval: ['mcp__gh__push'],
      approvedToolCalls: ['{"input":{},"name":"mcp__gh__push"}'],
    });
    expect(compiled.allowedTools).toEqual(['Read', 'mcp__jira__*', 'mcp__search__*']);
    expect(compiled.approval).toEqual({
      requireApproval: ['mcp__gh__push'],
      deferred: ['mcp__gh__*'],
      approvedToolCalls: ['{"input":{},"name":"mcp__gh__push"}'],
    });
  });

  it.each(AGENT_TOOL_PERMISSION_MODES.filter((mode) => mode !== 'default'))(
    'refuses permissionMode %s, which would not ask',
    (permissionMode) => {
      const allowDangerouslySkipPermissions = permissionMode === 'bypassPermissions';
      expect(() =>
        withTools(
          { ...defaultTools, permissionMode, allowDangerouslySkipPermissions },
          { requireApproval: ['Write'] },
        ),
      ).toThrow("permissionMode 'default'");
    },
  );

  it.each(['Read', 'Glob', 'Grep', 'Agent', 'TodoWrite'])(
    'refuses gating %s, which canUseTool is never asked about',
    (tool) => {
      expect(() => withTools(defaultTools, { requireApproval: [tool] })).toThrow(
        `requireApproval cannot gate ${JSON.stringify(tool)}`,
      );
    },
  );

  it.each(['Bash', 'WebFetch', 'mcp__jira__*', 'mcp__gh__push'])(
    'compiles a gate on %s',
    (tool) => {
      expect(
        withTools(defaultTools, { requireApproval: [tool] }).approval?.requireApproval,
      ).toEqual([tool]);
    },
  );

  it('allows any permissionMode when nothing requires approval', () => {
    expect(() => compileRunRequest(request)).not.toThrow();
  });
});
