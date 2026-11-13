import type { EngineRunRequest } from '@agent-workspace/engine';
import { createScriptedGateway } from '@agent-workspace/engine/testing';
import { expect, it } from 'vitest';

import type { RunDeps } from './boundary.js';
import { CLAUDE_AGENT_SDK_ENGINE_ID, createClaudeAgentSdkEngine } from './engine.js';
import {
  AGENT,
  CLAUDE_AGENT_SDK_ENGINE_ADAPTER,
  PROJECT_KEY,
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
