/**
 * The runner's engine registry (ENG-04, #303).
 *
 * The acceptance criterion this file exists for is the one about a runtime image that was built
 * without an adapter: *"deleting `node_modules/@agent-workspace/engine-claude-agent-sdk` from a
 * runner build makes `/run` answer `run-error {code:'engine_not_installed'}` and `/healthz`
 * report no engines. A test proves this with the registry's import stubbed."*
 *
 * Stubbing the module table rather than deleting a directory is the honest way to run that in
 * CI: the property is *"a loader that throws is an engine this image does not carry"*, and a
 * loader that rejects with `ERR_MODULE_NOT_FOUND` is the same input node hands the registry when
 * the package really is absent. What a directory deletion would additionally prove — that node's
 * resolver raises that error for that package — is node's behaviour, not this repository's.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, afterEach } from 'vitest';

import { RunRequest } from '@agent-workspace/core';

import {
  CLAUDE_AGENT_SDK_ENGINE_ADAPTER,
  CLAUDE_AGENT_SDK_ENGINE_ID,
} from '@agent-workspace/engine-claude-agent-sdk';
import {
  OPENAI_AGENTS_ENGINE_ADAPTER,
  OPENAI_AGENTS_ENGINE_ID,
} from '@agent-workspace/engine-openai-agents';
import { MASTRA_ENGINE_ADAPTER, MASTRA_ENGINE_ID } from '@agent-workspace/engine-mastra';
import { PI_ENGINE_ADAPTER, PI_ENGINE_ID } from '@agent-workspace/engine-pi';
import { createScriptedEngine, SCRIPTED_ENGINE_ID } from '@agent-workspace/engine/testing';

import {
  ADAPTER_ENGINE_IDS,
  configureEngineModulesForTests,
  installedEngines,
  loadEngine,
  resetEngineModules,
  toEngineRunRequest,
} from './engines.js';

afterEach(() => {
  resetEngineModules();
});

const RUN_REQUEST = {
  runId: '6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b',
  sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
  cwd: '/workspace/tenant-a/2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
  prompt: 'go',
  engine: CLAUDE_AGENT_SDK_ENGINE_ID,
  projectKey: 'tenant-a',
  portable: {
    name: 'A',
    instructions: '',
    model: null,
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
    skills: { mode: 'allowlist' as const, names: [] },
    mcpServers: {},
    limits: { maxTurns: null, maxBudgetUsd: null },
  },
  policy: { tools: null, fileGrantDeny: [] },
  session: { kind: 'fresh' as const, sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e' },
  env: { PATH: '/usr/bin' },
  resources: {
    files: [
      { kind: 'file' as const, path: 'a.md', contentBase64: 'YQ==', access: 'read' as const },
    ],
    skills: [{ name: 'support', files: [{ path: 'SKILL.md', contentBase64: 'YQ==' }] }],
  },
};

describe('the real registry', () => {
  it('loads the Claude adapter and reports it installed', async () => {
    const lookup = await loadEngine(CLAUDE_AGENT_SDK_ENGINE_ID);
    expect(lookup.ok).toBe(true);
    expect(lookup.ok ? lookup.engine : null).toBe(CLAUDE_AGENT_SDK_ENGINE_ADAPTER);

    const installed = await installedEngines();
    expect(installed.map((engine) => engine.id)).toEqual([
      CLAUDE_AGENT_SDK_ENGINE_ID,
      MASTRA_ENGINE_ID,
      OPENAI_AGENTS_ENGINE_ID,
      PI_ENGINE_ID,
    ]);
    expect(installed[0]?.version).toBe(CLAUDE_AGENT_SDK_ENGINE_ADAPTER.version);
    expect(installed[0]?.protectedConfigDirectory).toBe('.claude');
  });

  it('loads the OpenAI Agents adapter from its own row (ENG-09, #308)', async () => {
    const lookup = await loadEngine(OPENAI_AGENTS_ENGINE_ID);
    expect(lookup.ok).toBe(true);
    expect(lookup.ok ? lookup.engine : null).toBe(OPENAI_AGENTS_ENGINE_ADAPTER);
    expect(ADAPTER_ENGINE_IDS).toEqual(['claude-agent-sdk', 'mastra', 'openai-agents', 'pi']);
  });

  it('loads the pi adapter from its own row (ENG-08, #307)', async () => {
    const lookup = await loadEngine(PI_ENGINE_ID);
    expect(lookup.ok).toBe(true);
    expect(lookup.ok ? lookup.engine : null).toBe(PI_ENGINE_ADAPTER);
    expect(lookup.ok ? lookup.engine.protectedConfigDirectory : null).toBe('.pi');
  });

  it('loads the Mastra adapter from its own row (ENG-10, #309)', async () => {
    const lookup = await loadEngine(MASTRA_ENGINE_ID);
    expect(lookup.ok).toBe(true);
    expect(lookup.ok ? lookup.engine : null).toBe(MASTRA_ENGINE_ADAPTER);
    expect(lookup.ok ? lookup.engine.protectedConfigDirectory : null).toBe('.mastra');
  });

  it('refuses an engine it has no row for, naming what it does carry', async () => {
    const lookup = await loadEngine('openai-agents-sdk');
    expect(lookup.ok).toBe(false);
    expect(lookup.ok ? '' : lookup.code).toBe('engine_not_installed');
    expect(lookup.ok ? '' : lookup.reason).toContain(CLAUDE_AGENT_SDK_ENGINE_ID);
  });
});

describe('a runtime image built without an adapter', () => {
  it('answers engine_not_installed when the package cannot be loaded', async () => {
    configureEngineModulesForTests({
      [CLAUDE_AGENT_SDK_ENGINE_ID]: () =>
        Promise.reject(
          Object.assign(
            new Error("Cannot find package '@agent-workspace/engine-claude-agent-sdk'"),
            { code: 'ERR_MODULE_NOT_FOUND' },
          ),
        ),
    });
    const lookup = await loadEngine(CLAUDE_AGENT_SDK_ENGINE_ID);
    expect(lookup.ok).toBe(false);
    expect(lookup.ok ? '' : lookup.code).toBe('engine_not_installed');
    expect(lookup.ok ? '' : lookup.reason).toContain('Cannot find package');
  });

  it('reports no engines on /healthz when nothing loads', async () => {
    configureEngineModulesForTests({
      [CLAUDE_AGENT_SDK_ENGINE_ID]: () => Promise.reject(new Error('absent')),
    });
    expect(await installedEngines()).toEqual([]);
  });

  it('caches the refusal, so a second request does not re-enter the module loader', async () => {
    let attempts = 0;
    configureEngineModulesForTests({
      [CLAUDE_AGENT_SDK_ENGINE_ID]: () => {
        attempts += 1;
        return Promise.reject(Object.assign(new Error('absent'), { code: 'ERR_MODULE_NOT_FOUND' }));
      },
    });
    await loadEngine(CLAUDE_AGENT_SDK_ENGINE_ID);
    await loadEngine(CLAUDE_AGENT_SDK_ENGINE_ID);
    // An absent module is a fact about this image, not a transient (ADR-0015).
    expect(attempts).toBe(1);
  });

  it('retries a load that failed for any other reason', async () => {
    let attempts = 0;
    configureEngineModulesForTests({
      [CLAUDE_AGENT_SDK_ENGINE_ID]: () => {
        attempts += 1;
        return Promise.reject(new Error('EMFILE: too many open files'));
      },
    });
    await loadEngine(CLAUDE_AGENT_SDK_ENGINE_ID);
    await loadEngine(CLAUDE_AGENT_SDK_ENGINE_ID);
    expect(attempts).toBe(2);
  });
});

describe('a module that loads but is not the engine it claims to be', () => {
  it('refuses a module with no AgentEngine export', async () => {
    configureEngineModulesForTests({
      [CLAUDE_AGENT_SDK_ENGINE_ID]: () => Promise.resolve({ somethingElse: 1 }),
    });
    const lookup = await loadEngine(CLAUDE_AGENT_SDK_ENGINE_ID);
    expect(lookup.ok).toBe(false);
    expect(lookup.ok ? '' : lookup.reason).toContain('is not an AgentEngine');
  });

  it('refuses an adapter whose own id is not the one it was registered under', async () => {
    // Running a request on an engine other than the one it named is the failure this registry
    // exists to make impossible: the tool policy, the skills and the session were all composed
    // for one engine.
    configureEngineModulesForTests({
      [CLAUDE_AGENT_SDK_ENGINE_ID]: () =>
        Promise.resolve({ CLAUDE_AGENT_SDK_ENGINE_ADAPTER: createScriptedEngine() }),
    });
    const lookup = await loadEngine(CLAUDE_AGENT_SDK_ENGINE_ID);
    expect(lookup.ok).toBe(false);
    expect(lookup.ok ? '' : lookup.reason).toContain(SCRIPTED_ENGINE_ID);
  });
});

describe('toEngineRunRequest', () => {
  it('forwards the engine arm uninterpreted and keeps the bytes off the port', () => {
    const request = toEngineRunRequest(RUN_REQUEST);
    // `unknown` in, `unknown` out: the arm is addressed to an adapter and this application never
    // looks inside it (ENG-04b).
    expect(request.policy).toEqual(RUN_REQUEST.policy);
    expect(request.portable).toEqual(RUN_REQUEST.portable);
    expect(request.projectKey).toBe('tenant-a');
    expect(request.engine).toBe(CLAUDE_AGENT_SDK_ENGINE_ID);
    // File grants cross without their content — the runner already wrote them.
    expect(request.resources.files).toEqual([{ kind: 'file', path: 'a.md', access: 'read' }]);
    // Skills cross *with* their content, because where a skill goes is the engine's decision.
    expect(request.resources.skills).toEqual([
      { name: 'support', files: [{ path: 'SKILL.md', contentBase64: 'YQ==' }] },
    ]);
  });

  it('forwards the portable subagents verbatim', () => {
    const subagents = [
      {
        name: 'billing',
        description: 'Answers billing questions.',
        instructions: 'You answer billing questions.',
        model: null,
        permissions: RUN_REQUEST.portable.permissions,
      },
    ];
    const request = toEngineRunRequest(
      RunRequest.parse({ ...RUN_REQUEST, portable: { ...RUN_REQUEST.portable, subagents } }),
    );
    expect(request.portable.subagents).toEqual(subagents);
    expect(toEngineRunRequest(RUN_REQUEST).portable.subagents).toBeUndefined();
  });

  it('maps the contract session modes onto the port selector', () => {
    expect(toEngineRunRequest(RUN_REQUEST).session).toEqual({ mode: 'fresh' });
    expect(
      toEngineRunRequest({
        ...RUN_REQUEST,
        session: { kind: 'resume', resume: 'c101d922-3c4b-4a12-9b1e-0a1b2c3d4e5f' },
      }).session,
    ).toEqual({ mode: 'resume', engineSessionId: 'c101d922-3c4b-4a12-9b1e-0a1b2c3d4e5f' });
    expect(
      toEngineRunRequest({
        ...RUN_REQUEST,
        session: {
          kind: 'fork',
          resume: 'c101d922-3c4b-4a12-9b1e-0a1b2c3d4e5f',
          sessionId: RUN_REQUEST.sessionId,
        },
      }).session,
    ).toEqual({ mode: 'fork', engineSessionId: 'c101d922-3c4b-4a12-9b1e-0a1b2c3d4e5f' });
  });

  it('carries a gateway connection when the body has one and null when it does not', () => {
    expect(toEngineRunRequest(RUN_REQUEST).gateway).toBeNull();
    const gateway = {
      baseUrl: 'https://gateway.internal',
      token: 'run-token',
      protocol: 'anthropic-messages',
    };
    expect(toEngineRunRequest({ ...RUN_REQUEST, gateway }).gateway).toEqual(gateway);
  });

  // S2-02f (#531): a gateway tool connector entry, keyed by a 16-character SD13 key, crosses the
  // runner verbatim and every MCP-capable adapter compiles it.
  it.each([
    [CLAUDE_AGENT_SDK_ENGINE_ID, { tools: null, fileGrantDeny: [] }, 'anthropic-messages'],
    [OPENAI_AGENTS_ENGINE_ID, {}, 'openai-responses'],
    [MASTRA_ENGINE_ID, {}, 'anthropic-messages'],
  ] as const)('keeps a gateway tool entry and %s compiles it', async (engine, policy, protocol) => {
    const key = 'abcdefghijklmn_2';
    const entry = {
      type: 'http' as const,
      url: 'http://gateway:4000/v1/tools/00000000-0000-4000-8000-00000000000a/mcp',
      headers: { authorization: 'Bearer run-token' },
    };
    const request = toEngineRunRequest(
      RunRequest.parse({
        ...RUN_REQUEST,
        engine,
        portable: {
          ...RUN_REQUEST.portable,
          model: 'claude-sonnet-4-5',
          mcpServers: { [key]: entry },
        },
        policy,
        gateway: { baseUrl: 'http://gateway:4000', token: 'run-token', protocol },
        resources: { files: [], skills: [] },
      }),
    );
    expect(request.portable.mcpServers).toEqual({ [key]: entry });
    const lookup = await loadEngine(engine);
    if (!lookup.ok) throw new Error(lookup.reason);
    const compiled = lookup.engine.compile(request);
    expect(compiled.ok ? 'ok' : `${compiled.code}: ${compiled.reason}`).toBe('ok');
  });
});

// ENG-07 (#306, ADR-0073 D1): the manager admits an `engine → image` entry for exactly the engines
// this repository has an adapter package for, which is also the list `scripts/engine-images.mjs`
// builds a runtime image for. Both are derived; this holds them to each other.
describe('ADAPTER_ENGINE_IDS', () => {
  it('is the set of packages/engine-<id> adapter directories', () => {
    const packages = path.resolve(import.meta.dirname, '../../../packages');
    const directories = readdirSync(packages, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('engine-'))
      .map((entry) => entry.name.slice('engine-'.length))
      .sort();
    expect([...ADAPTER_ENGINE_IDS]).toEqual(directories);
  });
});
