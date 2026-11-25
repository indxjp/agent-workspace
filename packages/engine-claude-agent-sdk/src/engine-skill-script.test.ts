import type { ClassifiedSdkEvent } from '@agent-workspace/run-protocol';
import {
  runSkillScript,
  SKILL_SCRIPT_LIMITS,
  type EngineRunRequest,
  type SkillScriptHost,
} from '@agent-workspace/engine';
import {
  createFakeSessionStore,
  createScriptedGateway,
  type FakeSessionStore,
} from '@agent-workspace/engine/testing';
import { describe, expect, it } from 'vitest';

import type { RunDeps } from './boundary.js';
import { CLAUDE_AGENT_SDK_ENGINE_ID, createClaudeAgentSdkEngine } from './engine.js';
import {
  AGENT,
  CLAUDE_AGENT_SDK_ENGINE_ADAPTER,
  PROJECT_KEY,
  RECORDED_RUN,
  replayingStarter,
} from './engine.test-support.js';
import { CLAUDE_SKILL_SCRIPT_TOOL } from './skill-script.js';

const gateway = createScriptedGateway();
const approved = {
  tools: {
    base: 'claude_code_preset',
    autoApprove: [CLAUDE_SKILL_SCRIPT_TOOL],
    deny: [],
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
  },
  fileGrantDeny: [],
};
const request: EngineRunRequest = {
  runId: '6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b',
  sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
  projectKey: PROJECT_KEY,
  cwd: '/workspace/conformance',
  prompt: 'go',
  engine: CLAUDE_AGENT_SDK_ENGINE_ID,
  portable: { ...AGENT, skills: { mode: 'allowlist', names: ['review'] } },
  policy: approved,
  session: { mode: 'fresh' },
  gateway: gateway.connection,
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
          { path: 'scripts/check.mjs', contentBase64: 'Y29uc29sZS5sb2coMSk=' },
        ],
      },
    ],
  },
  env: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: gateway.connection.token },
};

function handedTo(startRequest: EngineRunRequest): RunDeps | undefined {
  const handed: (RunDeps | undefined)[] = [];
  const starter = replayingStarter();
  createClaudeAgentSdkEngine((runRequest, deps) => {
    handed.push(deps);
    return starter(runRequest, deps);
  }).start(startRequest);
  return handed[0];
}

it('hands the run starter the scripts, the skills and the read-write grants only', () => {
  expect(handedTo(request)?.skillScript).toEqual({
    cwd: '/workspace/conformance',
    skillsDirectory: '.claude/skills',
    skills: [{ name: 'review', scripts: ['check.mjs'] }],
    writable: ['drafts', 'outputs'],
    writableDirectories: ['drafts', 'outputs'],
  });
});

it('keeps Bash denied under the read-only grant, and does not deny the pre-approved tool', () => {
  const compiled = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile(request);
  if (!compiled.ok) throw new Error(compiled.reason);
  expect(compiled.compiled.disallowedTools).toContain('Bash');
  expect(compiled.compiled.disallowedTools).not.toContain(CLAUDE_SKILL_SCRIPT_TOOL);
  expect(compiled.compiled.allowedTools).toContain(CLAUDE_SKILL_SCRIPT_TOOL);
});

it('offers nothing when commands are off, no skill ships a script, or the skill is not granted', () => {
  const noScripts = {
    ...request.resources,
    skills: [{ name: 'review', files: [{ path: 'SKILL.md', contentBase64: 'IyBSZXZpZXc=' }] }],
  };
  const variants: EngineRunRequest[] = [
    {
      ...request,
      portable: {
        ...request.portable,
        permissions: { ...AGENT.permissions, runCommands: false },
      },
    },
    { ...request, resources: noScripts },
    { ...request, portable: { ...request.portable, skills: { mode: 'allowlist', names: [] } } },
  ];
  for (const variant of variants) {
    expect(handedTo(variant)?.skillScript).toBeUndefined();
  }
});

it('offers no write path when the agent may not write files', () => {
  const readOnly: EngineRunRequest = {
    ...request,
    portable: { ...request.portable, permissions: { ...AGENT.permissions, writeFiles: false } },
  };
  expect(handedTo(readOnly)?.skillScript?.writable).toEqual([]);
});

it('refuses a connector that takes the name of the server that carries the tool', () => {
  const refused = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
    ...request,
    portable: {
      ...request.portable,
      mcpServers: { 'agent-workspace': { command: 'node', args: ['server.mjs'] } },
    },
  });
  expect(refused.ok ? '' : refused.code).toBe('engine_policy_invalid');
  expect(refused.ok ? '' : refused.reason).toContain('run_skill_script');
});

import { vi } from 'vitest';

// The real `compileRunRequest` behind a spy, so a test can count the compiles one start performs.
vi.mock('./compile.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./compile.js')>();
  return { ...original, compileRunRequest: vi.fn(original.compileRunRequest) };
});

describe('the answers a run_skill_script call may reference (ADR-0176)', () => {
  function started(
    startRequest: EngineRunRequest,
    sessionStore?: FakeSessionStore,
    events: readonly ClassifiedSdkEvent[] = RECORDED_RUN,
  ) {
    const handed: (RunDeps | undefined)[] = [];
    const starter = replayingStarter(events);
    const connection = createClaudeAgentSdkEngine((runRequest, deps) => {
      handed.push(deps);
      return starter(runRequest, deps);
    }).start(startRequest, sessionStore === undefined ? {} : { sessionStore });
    const deps = handed[0];
    if (deps?.toolAnswers === undefined) throw new Error('no record of tool answers was handed');
    return { connection, deps, answers: deps.toolAnswers };
  }

  it('hands the tool the record the kit fills from this run’s own frames', async () => {
    const { connection, answers } = started(request);
    expect(answers.held()).toEqual([]);
    for await (const frame of connection.frames) expect(frame.engine).toBe('claude-agent-sdk');
    expect(await answers.find('toolu_01')).toEqual({
      toolCallId: 'toolu_01',
      name: 'Read',
      output: 'the document',
      isError: false,
    });
  });

  it('never records a subagent’s answer, nor names its id in a refusal', async () => {
    const session = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const subagent: readonly ClassifiedSdkEvent[] = [
      {
        kind: 'event',
        type: 'assistant',
        event: {
          type: 'assistant',
          session_id: session,
          parent_tool_use_id: 'toolu_task',
          message: {
            id: 'msg_sub',
            content: [{ type: 'tool_use', id: 'toolu_sub', name: 'Read', input: {} }],
          },
        },
      },
      {
        kind: 'event',
        type: 'user',
        event: {
          type: 'user',
          session_id: session,
          parent_tool_use_id: 'toolu_task',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_sub', content: 'secret' }],
          },
        },
      },
    ];
    const [init, ...rest] = RECORDED_RUN;
    const events = init === undefined ? subagent : [init, ...subagent, ...rest];
    const { connection, answers } = started(request, undefined, events);
    for await (const frame of connection.frames) expect(frame.engine).toBe('claude-agent-sdk');
    expect(answers.held()).toEqual([{ toolCallId: 'toolu_01', name: 'Read' }]);
    const aborted = AbortSignal.abort();
    expect(await answers.find('toolu_sub', aborted)).toBeNull();

    // The refusal of the subagent's id names only the run's own answers.
    const host: SkillScriptHost = {
      execPath: 'node',
      realpath: (path) => Promise.resolve(path),
      path: {
        join: (...segments) => segments.join('/'),
        relative: (from, to) => (to.startsWith(`${from}/`) ? to.slice(from.length + 1) : ''),
        isAbsolute: (path) => path.startsWith('/'),
      },
      execFile: () => Promise.reject(new Error('must not run')),
      makeScratchDirectory: () => Promise.reject(new Error('must not run')),
      writeFile: () => Promise.reject(new Error('must not run')),
      makeDirectory: () => Promise.resolve(),
      removeDirectory: () => Promise.resolve(),
    };
    const outcome = await runSkillScript(
      host,
      {
        cwd: '/w',
        skillsDirectory: '.claude/skills',
        skills: [{ name: 'review', scripts: ['check.mjs'] }],
        writable: [],
        writableDirectories: [],
      },
      { skill: 'review', script: 'check.mjs', args: [], fromToolUse: 'toolu_sub' },
      SKILL_SCRIPT_LIMITS,
      aborted,
      answers,
    );
    expect(outcome).toMatchObject({ ok: false, refusal: 'unknown_tool_answer' });
    const reason = outcome.ok ? '' : outcome.reason;
    expect(reason).toContain('toolu_01 (Read)');
    expect(reason.match(/toolu_sub/gu)).toHaveLength(1);
  });

  it('hands no record when the run offers no script', () => {
    const handed: (RunDeps | undefined)[] = [];
    createClaudeAgentSdkEngine((runRequest, deps) => {
      handed.push(deps);
      return replayingStarter()(runRequest, deps);
    }).start({
      ...request,
      portable: { ...request.portable, skills: { mode: 'allowlist', names: [] } },
    });
    expect(handed[0]?.toolAnswers).toBeUndefined();
  });

  const TRANSCRIPT = [
    {
      type: 'assistant',
      uuid: 'a1',
      message: {
        id: 'msg_09',
        content: [
          { type: 'tool_use', id: 'toolu_09', name: 'mcp__peers__public_source', input: {} },
        ],
      },
    },
    {
      type: 'user',
      uuid: 's1',
      parent_tool_use_id: 'toolu_task',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_sub', content: 'secret' }],
      },
    },
    {
      type: 'user',
      uuid: 'u1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_09', content: '{"records":[]}' }],
      },
    },
  ];
  const KEY = { projectKey: PROJECT_KEY, sessionId: 'resumed' };

  /** The store a continuation resumes from, holding the paused run's transcript. */
  async function pausedSession(): Promise<FakeSessionStore> {
    const store = createFakeSessionStore();
    await store.append(KEY, TRANSCRIPT);
    return store;
  }

  const gated = {
    ...request,
    policy: {
      tools: null,
      fileGrantDeny: [],
      requireApproval: [CLAUDE_SKILL_SCRIPT_TOOL],
      approvedToolCalls: ['{"input":{},"name":"mcp__agent-workspace__run_skill_script"}'],
    },
  } satisfies EngineRunRequest;

  it('records, in a continuation of an approval, the answers of the main transcript it resumes', async () => {
    const { deps, answers } = started(gated, await pausedSession());
    await deps.sessionStore?.load({ ...KEY, subpath: 'subagents/agent-1' });
    expect(answers.held()).toEqual([]);
    await deps.sessionStore?.load(KEY);
    expect(await answers.find('toolu_09')).toMatchObject({
      name: 'mcp__peers__public_source',
      output: '{"records":[]}',
    });
    expect(answers.held().map((held) => held.toolCallId)).toEqual(['toolu_09']);
  });

  it('records nothing from a resumed transcript outside a continuation of an approval', async () => {
    for (const fresh of [
      { ...gated, policy: { ...gated.policy, approvedToolCalls: [] } },
      { ...gated, policy: { tools: null, fileGrantDeny: [] } },
    ]) {
      const { deps, answers } = started(fresh, await pausedSession());
      expect(await deps.sessionStore?.load(KEY)).toHaveLength(3);
      expect(answers.held()).toEqual([]);
    }
  });

  it('records nothing from an empty session', async () => {
    const { deps, answers } = started(gated, createFakeSessionStore());
    expect(await deps.sessionStore?.load(KEY)).toBeNull();
    expect(answers.held()).toEqual([]);
  });
});
