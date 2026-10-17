/**
 * The Claude Agent SDK adapter, behind the port (ENG-04, #303).
 *
 * Three things are checked here, and the middle one is the acceptance criterion.
 *
 *  1. **The restated version and capabilities are held to their sources.** The version is
 *     compared against this package's own manifest and the capability set against the
 *     control-plane registry's copy — the "watched by a replay, not by a comment" rule of
 *     `docs/adr/W2-CP-07-a-restatement-across-a-package-boundary-is-watched-by-a-replay-not-a-comment.md`.
 *     The registry's copy exists because `apps/web` may not import an engine adapter; without
 *     this assertion the two would drift and the catalogue would advertise capabilities the
 *     runtime does not have.
 *
 *  2. **The conformance kit reports PASS on every scenario.** The kit is
 *     `@agent-workspace/engine/testing` and it is the *same* scenario list the scripted engine
 *     is driven through, which is what makes a scenario a statement about the port rather than
 *     about one engine. The run is against **recorded SDK messages**: `createClaudeAgentSdkEngine`
 *     takes the one function that calls `query()` as a parameter, so everything else in the
 *     adapter — the policy parse, the compile, the gateway handling, the `agent.*` mapping, the
 *     session-id promise, the durability verdict — is exercised for real without a credential
 *     or a subprocess.
 *
 *  3. **The port translation is behaviour-preserving.** `compile` is `compileRunRequest`, and
 *     what this file adds is the `EngineRunRequest` → `RunRequest` step in front of it; the
 *     assertions below are that the step maps the three session modes onto the three legal SDK
 *     combinations R-01 §6 allows, and nothing else.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ClassifiedSdkEvent } from '@agent-workspace/core';
import {
  createScriptedGateway,
  expectConformance,
  type EngineConformanceSubject,
} from '@agent-workspace/engine/testing';
import type { EngineRunRequest, SessionDurabilityVerdict } from '@agent-workspace/engine';
import { skillPlacementVerdict } from '@agent-workspace/engine';
import { describe, expect, it } from 'vitest';

import type { ClaudeRun, RunDeps } from './boundary.js';
import {
  CLAUDE_AGENT_SDK_CAPABILITIES,
  CLAUDE_AGENT_SDK_ENGINE_ADAPTER,
  CLAUDE_AGENT_SDK_ENGINE_ID,
  CLAUDE_AGENT_SDK_VERSION,
  claudeGatewayEnv,
  createClaudeAgentSdkEngine,
} from './engine.js';
import type { CompiledSdkOptions } from './options.js';
import { ClaudeRunPolicy } from './policy.js';
import { CLAUDE_PROTECTED_CONFIG_DIRECTORY } from './scope.js';
import { CLAUDE_SKILL_SCRIPT_TOOL } from './skill-script.js';
import { claudeOptionsAllowPermission, claudeOptionsAllowWrite } from './tools.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The portable core every request below carries — §17's agent, minus the tool vocabulary.
 *
 * Every permission is granted: the grant scenarios and the permission scenario each narrow one
 * thing and compare against this baseline, so a baseline that already forbade something would let
 * an adapter that forbids everything look conformant. The `tools` this fixture used to carry is now
 * the engine arm, {@link POLICY}.
 */
const AGENT = {
  name: 'Conformance agent',
  instructions: '',
  model: null,
  permissions: {
    readFiles: true,
    writeFiles: true,
    runCommands: true,
    unrestrictedNetwork: true,
  },
  skills: { mode: 'allowlist', names: [] },
  mcpServers: {},
  limits: { maxTurns: null, maxBudgetUsd: null },
} as const;

/** The Claude engine arm: an agent whose `policy` column is NULL and no compose-side guard. */
const POLICY = { tools: null, fileGrantDeny: [] } as const;

const PROJECT_KEY = 'tenant-a';

/**
 * One recorded Claude Agent SDK run, as `classifySdkEvent` hands it to the adapter.
 *
 * These are the envelopes the SDK really emits — `system/init` carrying `session_id`, an
 * assistant turn with prose and a tool call, the paired `tool_result`, and a `result/success`
 * with `modelUsage`. They are the fixtures the conformance run replays, so the mapping the kit
 * observes is the mapping a real run would produce.
 */
const RECORDED_RUN: readonly ClassifiedSdkEvent[] = [
  {
    kind: 'system',
    subtype: 'init',
    event: {
      type: 'system',
      subtype: 'init',
      session_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      model: 'claude-sonnet-4-5',
    },
  },
  {
    kind: 'event',
    type: 'assistant',
    event: {
      type: 'assistant',
      session_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      message: {
        id: 'msg_01',
        content: [
          { type: 'text', text: 'Reading the document.' },
          { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { path: '/workspace/a.md' } },
        ],
      },
    },
  },
  {
    kind: 'event',
    type: 'user',
    event: {
      type: 'user',
      session_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      uuid: 'evt_02',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'the document' }],
      },
    },
  },
  {
    kind: 'result',
    subtype: 'success',
    carriesUsage: true,
    event: {
      type: 'result',
      subtype: 'success',
      session_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      num_turns: 1,
      total_cost_usd: 0.0012,
      modelUsage: {
        'claude-sonnet-4-5': { inputTokens: 100, outputTokens: 20, thinkingTokens: 5 },
      },
    },
  },
];

/**
 * A `startRun` that replays {@link RECORDED_RUN} instead of calling `query()`.
 *
 * It reproduces the two behaviours of the real one the kit asks about: the transcript mirror is
 * driven (so the durability verdict has something to be about), and `abort()` stops the stream.
 * Everything else — the mapping, the session id, the frame order — is the adapter's own code.
 */
function replayingStarter(events: readonly ClassifiedSdkEvent[] = RECORDED_RUN) {
  return (_request: unknown, deps: RunDeps = {}): ClaudeRun => {
    const controller = deps.abortController ?? new AbortController();
    let mirrored = 0;
    let exhausted = false;
    let sawResult = false;
    const stream = async function* (): AsyncGenerator<ClassifiedSdkEvent, void, void> {
      for (const event of events) {
        if (controller.signal.aborted) break;
        if (deps.sessionStore !== undefined) {
          await deps.sessionStore.append({ projectKey: PROJECT_KEY, sessionId: 'recorded' }, [
            { type: 'recorded' },
          ]);
          mirrored += 1;
        }
        if (event.kind === 'result') sawResult = true;
        yield event;
      }
      exhausted = true;
    };
    return {
      events: stream(),
      sessionDurability: (): SessionDurabilityVerdict => {
        if (!exhausted) {
          return { durable: false, reason: 'the event stream has not been exhausted.' };
        }
        if (deps.sessionStore === undefined) {
          return {
            durable: false,
            reason:
              'no sessionStore was supplied, so this session exists only inside the sandbox (spec §14.9).',
          };
        }
        if (!sawResult) {
          return { durable: false, reason: "the stream ended without a 'result' event." };
        }
        if (mirrored === 0) {
          return { durable: false, reason: 'the sessionStore received no append() call.' };
        }
        return { durable: true, mirroredBatches: mirrored };
      },
      abort: (reason?: unknown) => {
        controller.abort(reason);
      },
    };
  };
}

function subject(
  events: readonly ClassifiedSdkEvent[] = RECORDED_RUN,
): EngineConformanceSubject<CompiledSdkOptions> {
  return {
    engine: createClaudeAgentSdkEngine(replayingStarter(events)),
    policy: POLICY,
    unreadablePolicy: { tools: 'every-tool' },
    compiledEnv: (compiled) => compiled.env,
    writeAllowed: claudeOptionsAllowWrite,
    permissionAllowed: claudeOptionsAllowPermission,
    connectorsCompiled: (compiled) => Object.keys(compiled.mcpServers),
    subagentsCompiled: (compiled) => Object.keys(compiled.agents ?? {}),
    // The Claude adapter still reads its credential out of `env` on a pre-v2 body (ADR-0070), so
    // the conformance request's env carries the two variables compose writes today, built from
    // the scripted gateway's own connection. That is what makes `no-provider-credential-in-the-
    // sandbox` check a real token and `gateway-is-programmatic` check that the adapter keeps both.
    gatewayEnv: claudeGatewayEnv,
    gateway: createScriptedGateway({ token: 'run-token-for-conformance' }),
  };
}

describe('the restated constants are held to their sources', () => {
  it('reports the version this package actually depends on', () => {
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(CLAUDE_AGENT_SDK_VERSION).toBe(manifest.dependencies['@anthropic-ai/claude-agent-sdk']);
    expect(CLAUDE_AGENT_SDK_ENGINE_ADAPTER.version).toBe(CLAUDE_AGENT_SDK_VERSION);
  });

  it('answers to the id the catalogue publishes and declares its own config directory', () => {
    expect(CLAUDE_AGENT_SDK_ENGINE_ADAPTER.id).toBe(CLAUDE_AGENT_SDK_ENGINE_ID);
    expect(CLAUDE_AGENT_SDK_ENGINE_ADAPTER.protectedConfigDirectory).toBe(
      CLAUDE_PROTECTED_CONFIG_DIRECTORY,
    );
    expect(CLAUDE_PROTECTED_CONFIG_DIRECTORY).toBe('.claude');
  });

  it('declares the capabilities R-01 measured', () => {
    expect(CLAUDE_AGENT_SDK_ENGINE_ADAPTER.capabilities).toEqual(CLAUDE_AGENT_SDK_CAPABILITIES);
    // The two that decide a refusal at save time, named rather than inferred from the object.
    expect(CLAUDE_AGENT_SDK_CAPABILITIES.mcp).toBe(true);
    expect(CLAUDE_AGENT_SDK_CAPABILITIES.skills).toBe(true);
    expect(CLAUDE_AGENT_SDK_CAPABILITIES.fork).toBe(false);
    expect([...CLAUDE_AGENT_SDK_CAPABILITIES.wireProtocols]).toEqual(['anthropic-messages']);
  });
});

describe('the conformance kit against the Claude Agent SDK adapter', () => {
  it('reports PASS for every scenario, replaying recorded SDK messages', async () => {
    const verdicts = await expectConformance(subject());
    for (const verdict of verdicts) {
      expect(verdict.pass, `${verdict.scenario}: ${verdict.pass ? '' : verdict.reason}`).toBe(true);
    }
  });
});

describe('the port translation', () => {
  const gateway = createScriptedGateway();
  const base: EngineRunRequest = {
    runId: '6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b',
    sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
    projectKey: PROJECT_KEY,
    cwd: '/workspace/conformance',
    prompt: 'go',
    engine: CLAUDE_AGENT_SDK_ENGINE_ID,
    portable: AGENT,
    policy: POLICY,
    session: { mode: 'fresh' },
    gateway: gateway.connection,
    resources: { files: [], skills: [] },
    env: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: gateway.connection.token },
  };

  it('maps the three session modes onto the three legal SDK combinations (R-01 §6)', () => {
    const fresh = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile(base);
    expect(fresh.ok && fresh.compiled.sessionId).toBe(base.sessionId);
    expect(fresh.ok && fresh.compiled.resume).toBeUndefined();

    const resumed = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
      ...base,
      session: { mode: 'resume', engineSessionId: 'c101d922-3c4b-4a12-9b1e-0a1b2c3d4e5f' },
    });
    expect(resumed.ok && resumed.compiled.resume).toBe('c101d922-3c4b-4a12-9b1e-0a1b2c3d4e5f');
    expect(resumed.ok && resumed.compiled.sessionId).toBeUndefined();

    // `fork` is refused before it can be compiled, because the capability set says so. The
    // refusal is what keeps a request the engine cannot honour from being silently narrowed
    // into a fresh session, which is a different conversation.
    const forked = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
      ...base,
      session: { mode: 'fork', engineSessionId: 'c101d922-3c4b-4a12-9b1e-0a1b2c3d4e5f' },
    });
    expect(forked.ok).toBe(false);
    expect(forked.ok ? '' : forked.code).toBe('engine_capability_unsupported');
  });

  it('refuses subagents as engine_capability_unsupported when the tool policy removes Agent', () => {
    const subagent = {
      name: 'billing-specialist',
      description: 'Answers billing questions.',
      instructions: 'You answer billing questions.',
      model: null,
      permissions: base.portable.permissions,
    };
    const portable = { ...base.portable, subagents: [subagent] };
    const open = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({ ...base, portable });
    expect(open.ok && Object.keys(open.compiled.agents ?? {})).toEqual(['billing-specialist']);
    const refused = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
      ...base,
      portable,
      policy: {
        tools: {
          base: 'claude_code_preset',
          autoApprove: [],
          deny: ['Agent'],
          permissionMode: 'default',
          allowDangerouslySkipPermissions: false,
        },
        fileGrantDeny: [],
      },
    });
    expect(refused.ok ? '' : refused.code).toBe('engine_capability_unsupported');
    expect(refused.ok ? '' : refused.reason).toContain('removes Agent');
  });

  it('refuses a policy arm it cannot read rather than compiling a default', () => {
    for (const policy of [
      null,
      'claude',
      {},
      { tools: 'claude_code_preset' },
      { tools: null, fileGrantDeny: 'Bash' },
      { tools: null, extra: 1 },
    ]) {
      const refused = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({ ...base, policy });
      expect(refused.ok, JSON.stringify(policy)).toBe(false);
      expect(refused.ok ? '' : refused.code).toBe('engine_policy_invalid');
    }
  });

  it('derives the policy arm from the catalogue: strict, with fileGrantDeny defaulting to empty (#992)', () => {
    expect(ClaudeRunPolicy.parse({ tools: null })).toEqual({ tools: null, fileGrantDeny: [] });
    expect(ClaudeRunPolicy.safeParse({ tools: null, thinkingLevel: 'high' }).success).toBe(false);
  });

  it('files a credential-named env entry as engine_credential_refused from the typed verdict', () => {
    // `RunRequest.parse` would also reject this body, with a `ZodError` whose message names
    // ANTHROPIC_API_KEY. The code must come from the sandbox verdict, not from that message.
    const refused = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
      ...base,
      env: { ...base.env, ANTHROPIC_API_KEY: 'sk-ant-real' },
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.code).toBe('engine_credential_refused');
    expect(refused.ok ? '' : refused.reason).toContain('must never enter a sandbox');
  });

  it('files an unrelated parse failure as engine_policy_invalid even when it mentions a credential', () => {
    // An agent whose name mentions every word the old message match looked for: the refusal is a
    // bad policy arm, and its code must not depend on what the sentence happens to contain.
    const refused = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
      ...base,
      policy: { tools: { base: 'sandbox ANTHROPIC_API_KEY AUTH_TOKEN' }, fileGrantDeny: [] },
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.code).toBe('engine_policy_invalid');
  });

  it('compiles a read-only grant into write-tool and shell denials over the normalised path', () => {
    const granted = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
      ...base,
      resources: {
        files: [
          { kind: 'directory', path: './docs/', access: 'read' },
          { kind: 'file', path: 'notes/plan.md', access: 'read-write' },
        ],
        skills: [],
      },
    });
    if (!granted.ok) throw new Error(granted.reason);
    expect(granted.compiled.disallowedTools).toEqual([
      'Edit(//workspace/conformance/docs/**)',
      'Bash',
      'BashOutput',
      'KillShell',
    ]);
    expect(claudeOptionsAllowWrite(granted.compiled, 'docs/a/../b.md')).toBe(false);
    expect(claudeOptionsAllowWrite(granted.compiled, 'notes/plan.md')).toBe(true);
  });

  it('adds nothing to a deny list the control plane already narrowed for the same grant', () => {
    // compose's `applyFileGrantPolicy` writes the same rules into the request; the adapter's
    // de-duplication is what keeps those runs' compiled options exactly what they were.
    const already = ['Edit(//workspace/conformance/docs/**)', 'Bash', 'BashOutput', 'KillShell'];
    const granted = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
      ...base,
      policy: { tools: null, fileGrantDeny: already },
      resources: { files: [{ kind: 'directory', path: 'docs', access: 'read' }], skills: [] },
    });
    if (!granted.ok) throw new Error(granted.reason);
    expect(granted.compiled.disallowedTools).toEqual(already);
  });

  it('refuses a grant into its own configuration directory', () => {
    const refused = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
      ...base,
      resources: {
        files: [{ kind: 'file', path: 'x/../.claude/settings.json', access: 'read' }],
        skills: [],
      },
    });
    expect(refused.ok ? '' : refused.code).toBe('engine_policy_invalid');
  });

  it('places every granted skill file under CLAUDE_CONFIG_DIR/skills/<name>/ (spec §7, R-01 §8)', () => {
    const skills = [
      {
        name: 'invoice-review',
        files: [
          { path: 'SKILL.md', contentBase64: 'IyBJbnZvaWNlcw==' },
          { path: 'reference/rates.md', contentBase64: 'cmF0ZXM=' },
        ],
      },
    ];
    const placements = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.placeSkills({
      ...base,
      resources: { files: [], skills },
    });
    // The paths this engine chose, byte for byte what `apps/runner/src/resources.ts` wrote before
    // ENG-04b moved the decision behind the port — which is the behaviour-preservation claim for
    // skills: a resumed session finds its transcript and its skills exactly where it left them.
    expect(placements.map((placement) => placement.path)).toEqual([
      '.claude/skills/invoice-review/SKILL.md',
      '.claude/skills/invoice-review/reference/rates.md',
    ]);
    expect(
      skillPlacementVerdict(placements, skills, CLAUDE_PROTECTED_CONFIG_DIRECTORY),
    ).toMatchObject({ ok: true, files: 2 });
    expect(CLAUDE_AGENT_SDK_ENGINE_ADAPTER.placeSkills(base)).toEqual([]);
  });

  it('refuses a provider credential in the sandbox with its own code', () => {
    const refused = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
      ...base,
      env: { ...base.env, SOME_PROVIDER_API_KEY: 'sk-live-real-credential' },
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.code).toBe('engine_credential_refused');
  });
});

// Issue #661: the bundled CLI retried a rejected key for minutes before failing with a generic
// "API Error: 500"; the run now fails at the first auth retry with the code the preflight uses.
describe('a model call the provider refuses', () => {
  const gateway = createScriptedGateway();
  const request: EngineRunRequest = {
    runId: '6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b',
    sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
    projectKey: PROJECT_KEY,
    cwd: '/workspace/conformance',
    prompt: 'go',
    engine: CLAUDE_AGENT_SDK_ENGINE_ID,
    portable: AGENT,
    policy: POLICY,
    session: { mode: 'fresh' },
    gateway: gateway.connection,
    resources: { files: [], skills: [] },
    env: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: gateway.connection.token },
  };
  const [init, ...rest] = RECORDED_RUN;

  function retry(status: number | null): ClassifiedSdkEvent {
    return {
      kind: 'system',
      subtype: 'api_retry',
      event: {
        type: 'system',
        subtype: 'api_retry',
        session_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 500,
        error_status: status,
        error: status === 401 ? 'authentication_failed' : 'unknown',
      },
    };
  }

  /** The gateway's answer to the probe when the run token is good: the provider's `500`. */
  const tokenAccepted = (): Promise<Response> =>
    Promise.resolve(Response.json({ error: 'upstream' }, { status: 500 }));

  function started(
    status: number | null,
    probe: typeof fetch = tokenAccepted,
    startRequest: EngineRunRequest = request,
  ) {
    if (init === undefined) throw new Error('RECORDED_RUN is empty');
    const starter = replayingStarter([init, retry(status), ...rest]);
    const aborts: unknown[] = [];
    const probes: { url: string; authorization: string | null }[] = [];
    const engine = createClaudeAgentSdkEngine(
      (runRequest, deps) => {
        const run = starter(runRequest, deps);
        return {
          ...run,
          abort: (reason?: unknown) => {
            aborts.push(reason);
            run.abort(reason);
          },
        };
      },
      (input, init) => {
        probes.push({
          url: input instanceof Request ? input.url : input.toString(),
          authorization: new Headers(init?.headers).get('authorization'),
        });
        return probe(input, init);
      },
    );
    return { connection: engine.start(startRequest), aborts, probes };
  }

  async function failureOf(frames: AsyncIterable<unknown>): Promise<string> {
    const failure = await drain(frames).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    return failure instanceof Error ? failure.message : '';
  }

  async function drain(frames: AsyncIterable<unknown>): Promise<number> {
    const iterator = frames[Symbol.asyncIterator]();
    let count = 0;
    while (!(await iterator.next()).done) count += 1;
    return count;
  }

  it.each([401, 403])(
    'fails the run at the first retry after HTTP %i, and aborts it once',
    async (status) => {
      const { connection, aborts, probes } = started(status);
      const message = await failureOf(connection.frames);
      expect(probes).toEqual([
        {
          url: `${gateway.connection.baseUrl}/v1/models`,
          authorization: `Bearer ${gateway.connection.token}`,
        },
      ]);
      expect(message).toBe(
        `model_credential_rejected: the model provider rejected the API key (HTTP ${String(status)}).`,
      );
      expect(message).not.toContain(gateway.connection.token);
      expect(aborts).toHaveLength(1);
    },
  );

  it.each([429, 500, 529, null])(
    'keeps retrying after status %s and runs to its result',
    async (status) => {
      const { connection, aborts, probes } = started(status);
      await expect(drain(connection.frames)).resolves.toBeGreaterThan(0);
      expect(aborts).toHaveLength(0);
      expect(probes).toHaveLength(0);
    },
  );

  it.each([
    [401, 'token_invalid'],
    [401, 'token_revoked'],
    [403, 'token_run_mismatch'],
  ] as const)(
    "does not blame the key when the gateway refuses the run's own token (HTTP %i %s)",
    async (status, code) => {
      const { connection, aborts } = started(status, () =>
        Promise.resolve(
          Response.json(
            { type: 'error', error: { type: 'authentication_error', code, message: 'refused' } },
            { status },
          ),
        ),
      );
      const message = await failureOf(connection.frames);
      expect(message).toBe(
        `the model gateway refused this run's token (HTTP ${String(status)} ${code}).`,
      );
      expect(message).not.toMatch(/^model_credential_rejected:/u);
      expect(message).not.toContain(gateway.connection.token);
      expect(aborts).toHaveLength(1);
    },
  );

  it('blames the key when the gateway answers 401 without a token code (the provider refused it)', async () => {
    const { connection } = started(401, () =>
      Promise.resolve(Response.json({ error: { code: 'invalid_api_key' } }, { status: 401 })),
    );
    expect(await failureOf(connection.frames)).toMatch(/^model_credential_rejected:/u);
  });

  it('claims nothing about the key when the probe itself fails, and still stops', async () => {
    const { connection, aborts } = started(401, () =>
      Promise.reject(new TypeError('fetch failed')),
    );
    const message = await failureOf(connection.frames);
    expect(message).not.toMatch(/^model_credential_rejected:/u);
    expect(message).not.toContain(gateway.connection.token);
    expect(aborts).toHaveLength(1);
  });

  it('refuses a request with no gateway, whose own token would vouch for any key in env', () => {
    const refused = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
      ...request,
      gateway: null,
      env: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'sk-ant-test-SENTINEL' },
    });
    expect(refused.ok ? '' : refused.code).toBe('engine_credential_refused');
  });

  it('emits the frames of the rejecting retry, and only then fails the stream', async () => {
    const { connection } = started(401);
    const seen: string[] = [];
    let failure: unknown = null;
    try {
      for await (const frame of connection.frames) {
        seen.push(frame.frame === 'agent.native' ? frame.type : frame.frame);
      }
    } catch (error) {
      failure = error;
    }
    expect(seen).toEqual(['agent.session', 'system/api_retry']);
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : '').toMatch(/^model_credential_rejected:/u);
  });

  it('rejects engineSessionId when the stream ends without a system/init', async () => {
    const connection = createClaudeAgentSdkEngine(replayingStarter(rest)).start(request);
    await drain(connection.frames);
    await expect(connection.engineSessionId).rejects.toThrow(
      /ended without any frame carrying an engine session id/u,
    );
  });

  it('aborts the controller handed to the run starter on interrupt()', async () => {
    const handed: (AbortController | undefined)[] = [];
    const starter = replayingStarter();
    const connection = createClaudeAgentSdkEngine((runRequest, deps) => {
      handed.push(deps?.abortController);
      return starter(runRequest, deps);
    }).start(request);
    expect(handed[0]?.signal.aborted).toBe(false);
    await connection.interrupt();
    expect(handed[0]?.signal.aborted).toBe(true);
  });
});

describe('run_skill_script (ADR-0137)', () => {
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
      writable: ['drafts'],
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
});
