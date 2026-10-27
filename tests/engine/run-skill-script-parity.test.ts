/**
 * `run_skill_script` is one tool on every engine that can offer it (ADR-0137, #1089).
 *
 * The decisions are `@agent-workspace/engine`'s, so what could drift is the part each adapter owns:
 * the name the model sees, the input it declares, and when it is offered at all. This pins the
 * three together. OpenAI Agents declares `skills: false` and refuses a granted skill at compile, so
 * its tool is wired and never offered until skills are placed there (a follow-up of #1089).
 */
import {
  CLAUDE_SKILL_SCRIPT_INPUT,
  CLAUDE_SKILL_SCRIPT_SERVER,
  CLAUDE_SKILL_SCRIPT_TOOL,
  createClaudeAgentSdkEngine,
  type ClaudeRun,
  type RunDeps,
} from '@agent-workspace/engine-claude-agent-sdk/testing';
import {
  MASTRA_SKILL_SCRIPT_INPUT,
  compileMastraRun,
} from '@agent-workspace/engine-mastra/testing';
import {
  OPENAI_AGENTS_SKILL_SCRIPT_INPUT,
  compileOpenAiAgentsRun,
} from '@agent-workspace/engine-openai-agents/testing';
import {
  RUN_SKILL_SCRIPT_INPUT_JSON_SCHEMA,
  RUN_SKILL_SCRIPT_TOOL,
  skillScriptSetup,
  type EngineRunRequest,
  type SkillScriptSetup,
} from '@agent-workspace/engine';
import { describe, expect, it } from 'vitest';

const PERMISSIONS = {
  readFiles: true,
  writeFiles: true,
  runCommands: true,
  unrestrictedNetwork: false,
} as const;

function request(
  engine: EngineRunRequest['engine'],
  overrides: {
    runCommands?: boolean;
    scripts?: boolean;
    granted?: boolean;
  } = {},
): EngineRunRequest {
  const { runCommands = true, scripts = true, granted = true } = overrides;
  const gateway =
    engine === 'openai-agents'
      ? ({ baseUrl: 'http://gateway.test/', token: 'tok', protocol: 'openai-responses' } as const)
      : ({
          baseUrl: 'http://gateway.test/',
          token: 'tok',
          protocol: 'anthropic-messages',
        } as const);
  return {
    runId: '6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b',
    sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
    projectKey: 'tenant-a',
    cwd: '/workspace/run',
    prompt: 'go',
    engine,
    portable: {
      name: 'Reviewer',
      instructions: '',
      model: engine === 'openai-agents' ? 'gpt-test' : 'claude-sonnet-4-5',
      permissions: { ...PERMISSIONS, runCommands },
      skills: { mode: 'allowlist', names: granted ? ['review'] : [] },
      mcpServers: {},
      limits: { maxTurns: null, maxBudgetUsd: null },
    },
    policy: engine === 'claude-agent-sdk' ? { tools: null, fileGrantDeny: [] } : {},
    session: { mode: 'fresh' },
    gateway,
    resources: {
      files: [
        { kind: 'directory', path: 'contracts', access: 'read' },
        { kind: 'directory', path: 'drafts', access: 'read-write' },
      ],
      skills: [
        {
          name: 'review',
          files: [
            { path: 'SKILL.md', contentBase64: 'IyBSZXZpZXc=' },
            ...(scripts ? [{ path: 'scripts/check.mjs', contentBase64: 'eA==' }] : []),
          ],
        },
      ],
    },
    env: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'tok' },
  };
}

const CASES = [
  {},
  { runCommands: false },
  { scripts: false },
  { granted: false },
  { runCommands: false, scripts: false, granted: false },
] as const;

function claudeOffered(candidate: EngineRunRequest): SkillScriptSetup | undefined {
  let handed: RunDeps | undefined;
  const run: ClaudeRun = {
    events: (async function* () {})(),
    sessionDurability: () => ({ durable: false, reason: 'not run' }),
    approvalRequest: () => null,
    handoff: () => null,
    abort: () => undefined,
  };
  createClaudeAgentSdkEngine((_request, deps) => {
    handed = deps;
    return run;
  }).start(candidate);
  return handed?.skillScript;
}

function mastraOffered(candidate: EngineRunRequest): SkillScriptSetup | null {
  const compiled = compileMastraRun(candidate);
  if (!compiled.ok) throw new Error(compiled.reason);
  return compiled.compiled.skillScript;
}

describe('the tool name', () => {
  it('is run_skill_script, and Claude carries it on one reserved in-process server', () => {
    expect(RUN_SKILL_SCRIPT_TOOL).toBe('run_skill_script');
    expect(CLAUDE_SKILL_SCRIPT_SERVER).toBe('agent-workspace');
    expect(CLAUDE_SKILL_SCRIPT_TOOL).toBe('mcp__agent-workspace__run_skill_script');
  });
});

describe('the input schema', () => {
  const schema = RUN_SKILL_SCRIPT_INPUT_JSON_SCHEMA;
  const declared = {
    claude: CLAUDE_SKILL_SCRIPT_INPUT,
    mastra: MASTRA_SKILL_SCRIPT_INPUT,
    openai: OPENAI_AGENTS_SKILL_SCRIPT_INPUT,
  };

  it('declares the engine’s three fields on every adapter', () => {
    for (const [name, input] of Object.entries(declared)) {
      expect(Object.keys(input.shape).sort(), name).toEqual(Object.keys(schema.properties).sort());
    }
  });

  it('accepts the same calls and refuses the same mistakes', () => {
    const valid = [
      { skill: 'review', script: 'check.mjs', args: ['a.docx'] },
      { skill: 'review', script: 'check.mjs', args: [] },
    ];
    const invalid = [
      { skill: 'review' },
      { script: 'check.mjs' },
      { skill: 'review', script: 'check.mjs', args: 'a.docx' },
      { skill: 'review', script: 'check.mjs', args: [1] },
      { skill: 1, script: 'check.mjs', args: [] },
    ];
    for (const [name, input] of Object.entries(declared)) {
      for (const call of valid)
        expect(input.safeParse(call).success, `${name} ${JSON.stringify(call)}`).toBe(true);
      for (const call of invalid)
        expect(input.safeParse(call).success, `${name} ${JSON.stringify(call)}`).toBe(false);
    }
  });

  it('leaves args out where the schema allows it, and sends null where OpenAI’s strict schema needs it', () => {
    const noArgs = { skill: 'review', script: 'check.mjs' };
    expect(CLAUDE_SKILL_SCRIPT_INPUT.safeParse(noArgs).success).toBe(true);
    expect(MASTRA_SKILL_SCRIPT_INPUT.safeParse(noArgs).success).toBe(true);
    expect(OPENAI_AGENTS_SKILL_SCRIPT_INPUT.safeParse({ ...noArgs, args: null }).success).toBe(
      true,
    );
    expect(schema.required).toEqual(['skill', 'script']);
  });
});

describe('when the tool is offered', () => {
  it('Claude and Mastra offer it exactly when the shared predicate says so', () => {
    for (const overrides of CASES) {
      const expected = skillScriptSetup(request('claude-agent-sdk', overrides), '.claude');
      expect(
        claudeOffered(request('claude-agent-sdk', overrides)),
        JSON.stringify(overrides),
      ).toEqual(expected ?? undefined);
      const mastra = skillScriptSetup(request('mastra', overrides), '.mastra');
      expect(mastraOffered(request('mastra', overrides)), JSON.stringify(overrides)).toEqual(
        mastra,
      );
    }
  });

  it('offers it for the default case and for no other', () => {
    const offered = CASES.filter(
      (overrides) => claudeOffered(request('claude-agent-sdk', overrides)) !== undefined,
    );
    expect(offered).toEqual([{}]);
    expect(
      CASES.filter((overrides) => mastraOffered(request('mastra', overrides)) !== null),
    ).toEqual([{}]);
  });

  it('is absent whenever runCommands is off', () => {
    expect(claudeOffered(request('claude-agent-sdk', { runCommands: false }))).toBeUndefined();
    expect(mastraOffered(request('mastra', { runCommands: false }))).toBeNull();
  });

  it('is not offered by OpenAI Agents: a granted skill is refused at compile, any other run has no scripts', () => {
    for (const overrides of CASES) {
      const compiled = compileOpenAiAgentsRun(request('openai-agents', overrides));
      if (compiled.ok) expect(compiled.compiled.skillScript, JSON.stringify(overrides)).toBeNull();
    }
    const refused = compileOpenAiAgentsRun(request('openai-agents'));
    expect(refused.ok ? '' : refused.code).toBe('engine_capability_unsupported');
  });
});
