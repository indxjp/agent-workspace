import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createScriptedEngine } from '@agent-workspace/engine/testing';

import { configureEngineModulesForTests, resetEngineModules } from './engines.js';
import { PACKAGE_NAME, startAgentInThisContainer } from './index.js';
import type { ResolvedRunRequest } from './resources.js';

describe('@agent-workspace/runner', () => {
  it('is wired into the pnpm workspace', () => {
    expect(PACKAGE_NAME).toBe('@agent-workspace/runner');
  });
});

describe('startAgentInThisContainer', () => {
  const roots: string[] = [];

  afterEach(() => {
    resetEngineModules();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('answers a compile refusal before it writes anything into the sandbox', async () => {
    // ENG-09 (#308): materialising before compiling wrote the run's directories and its skills
    // into the sandbox, and only then did the engine refuse a skill it declares it cannot honour.
    // The adapter's own typed refusal is the answer, and the sandbox is untouched.
    const registered = 'claude-agent-sdk';
    const noSkills = {
      ...createScriptedEngine({ capabilities: { skills: false } }),
      id: registered,
    };
    configureEngineModulesForTests({
      [registered]: () => Promise.resolve({ createClaudeAgentSdkEngine: () => noSkills }),
    });
    const root = mkdtempSync(path.join(tmpdir(), 'runner-compile-first-'));
    roots.push(root);
    const cwd = path.join(root, 'tenant-a', 'session');
    const request: ResolvedRunRequest = {
      runId: '6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b',
      sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
      cwd,
      prompt: 'go',
      engine: registered,
      projectKey: 'tenant-a',
      portable: {
        name: 'A',
        instructions: '',
        model: null,
        permissions: {
          readFiles: true,
          writeFiles: true,
          runCommands: true,
          unrestrictedNetwork: false,
        },
        skills: { mode: 'allowlist', names: ['support'] },
        mcpServers: {},
        limits: { maxTurns: null, maxBudgetUsd: null },
      },
      policy: { kind: 'scripted' },
      session: { kind: 'fresh', sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e' },
      env: {},
      gateway: {
        baseUrl: 'http://gateway.invalid',
        token: 'run-token',
        protocol: 'openai-responses',
      },
      resources: {
        files: [],
        skills: [{ name: 'support', files: [{ path: 'SKILL.md', contentBase64: 'YQ==' }] }],
      },
    };

    const outcome = await startAgentInThisContainer(request, {});

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.code).toBe('engine_capability_unsupported');
    expect(existsSync(cwd)).toBe(false);
  });
});
