import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SessionDurabilityVerdict } from '@agent-workspace/engine';
import {
  createScriptedGateway,
  type EngineConformanceSubject,
} from '@agent-workspace/engine/testing';
import type { ClassifiedSdkEvent } from '@agent-workspace/run-protocol';

import type { ClaudeRun, RunDeps } from './boundary.js';
import { claudeGatewayEnv, createClaudeAgentSdkEngine } from './engine.js';
import type { CompiledSdkOptions } from './options.js';
import { claudeOptionsAllowPermission, claudeOptionsAllowWrite } from './options-readback.js';

// Each adapter package exports a factory, not a built adapter (W3-8): build one here.
export const CLAUDE_AGENT_SDK_ENGINE_ADAPTER = createClaudeAgentSdkEngine();

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The portable core every request below carries — §17's agent, minus the tool vocabulary.
 *
 * Every permission is granted: the grant scenarios and the permission scenario each narrow one
 * thing and compare against this baseline, so a baseline that already forbade something would let
 * an adapter that forbids everything look conformant. The `tools` this fixture used to carry is now
 * the engine arm, {@link POLICY}.
 */
export const AGENT = {
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
export const POLICY = { tools: null, fileGrantDeny: [] } as const;

export const PROJECT_KEY = 'tenant-a';

/**
 * One recorded Claude Agent SDK run, as `classifySdkEvent` hands it to the adapter.
 *
 * These are the envelopes the SDK really emits — `system/init` carrying `session_id`, an
 * assistant turn with prose and a tool call, the paired `tool_result`, and a `result/success`
 * with `modelUsage`. They are the fixtures the conformance run replays, so the mapping the kit
 * observes is the mapping a real run would produce.
 */
export const RECORDED_RUN: readonly ClassifiedSdkEvent[] = [
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
export function replayingStarter(events: readonly ClassifiedSdkEvent[] = RECORDED_RUN) {
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
      approvalRequest: () => null,
      handoff: () => null,
      abort: (reason?: unknown) => {
        controller.abort(reason);
      },
    };
  };
}

export function subject(
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
    outputSchemaCompiled: (compiled) => compiled.outputFormat?.schema,
    // The Claude adapter still reads its credential out of `env` on a pre-v2 body (ADR-0070), so
    // the conformance request's env carries the two variables compose writes today, built from
    // the scripted gateway's own connection. That is what makes `no-provider-credential-in-the-
    // sandbox` check a real token and `gateway-is-programmatic` check that the adapter keeps both.
    gatewayEnv: claudeGatewayEnv,
    gateway: createScriptedGateway({ token: 'run-token-for-conformance' }),
  };
}
