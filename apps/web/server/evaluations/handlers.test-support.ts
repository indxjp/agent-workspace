import type { AgentVersionRecord } from '@agent-workspace/core/db';
import { canonicalCall } from '@indx-workspace/contracts/agents';
import { EvaluationResourceSchema } from '@indx-workspace/contracts/evaluations';
import type { AgentFrame } from '@indx-workspace/contracts/run-events';
import { expect } from 'vitest';

import type {
  LaunchContext,
  RunLimitsOverride,
  RunPrincipal,
  RunApiEnvironment,
} from '../runs/environment';
import { InMemoryRunStore } from '../runs/memory-store';
import type { RunOutput, RunRecord, RunStatus, RunStreamHandle } from '../runs/store';
import { evaluateAgentVersion, type EvaluateAgentVersionDependencies } from './handlers';
import { assistantSays, ORDER_STATUS_FRAMES, toolCall, toolResult } from './fixtures';

export const WORKSPACE = '22222222-2222-4222-8222-222222222222';
export const AGENT = '33333333-3333-4333-8333-333333333333';
export const VERSION_ID = '44444444-4444-4444-8444-444444444444';
export const EVALUATION_ID = '55555555-5555-4555-8555-555555555555';
export const PRINCIPAL: RunPrincipal = {
  principalId: '77777777-7777-4777-8777-777777777777',
  ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
  userId: null,
  workspaceId: WORKSPACE,
  role: 'builder',
  scope: null,
};

/** What the fake runtime does with a prompt: play frames and end, or never answer. */
type Script =
  | {
      readonly frames: readonly AgentFrame[];
      readonly status: RunStatus;
      readonly error?: string;
      readonly output?: RunOutput;
      /** Stop for approval on this call instead of ending: `status` is then not used. */
      readonly pause?: { readonly toolName: string; readonly canonicalCall: string };
    }
  | 'hang';

const PLAN_WRITE = { file_path: 'outputs/plan.json', content: '{}' };

const SCRIPTS: Readonly<Record<string, Script>> = {
  // The pause has no `agent.tool.call` frame before it, so the paused call must come from the run.
  'Plan the consolidation': {
    frames: [assistantSays('Plan ready for approval.')],
    status: 'awaiting_approval',
    pause: { toolName: 'Write', canonicalCall: canonicalCall('Write', PLAN_WRITE) },
  },
  'Where is order 1042?': { frames: ORDER_STATUS_FRAMES, status: 'completed' },
  'I want my money back now': {
    frames: [assistantSays('I am sorry. I cannot refund it, but I can help.')],
    status: 'completed',
  },
  // EVL-01/02: a question asked before the last message, and a call the tool refused.
  'Ask, then try the tool': {
    frames: [
      assistantSays('Which order do you mean?', 'msg_a'),
      toolCall('orders_refund'),
      toolResult('call_orders_refund', 'error'),
      assistantSays('The refund was refused.', 'msg_b'),
    ],
    status: 'completed',
  },
  'Use the tool': { frames: [toolCall('orders_refund'), assistantSays('Done.')], status: 'failed' },
  'Draft the change set': {
    frames: [assistantSays('Drafted.')],
    status: 'completed',
    output: { text: 'Drafted.', structured: { width: 140, height: 90, drawingNo: 'BRK-1101' } },
  },
  'Never answers': 'hang',
  'Bad key': {
    frames: [],
    status: 'failed',
    error:
      'model_credential_rejected: the agent model connection "default": The provider rejected the API key (HTTP 401). Replace the key on this connection.',
  },
};

interface Setup {
  readonly judge?: RunApiEnvironment['judgeEvaluationCase'];
  readonly preflight?: RunApiEnvironment['preflight'];
  readonly deadlineMs?: number;
  readonly limits?: RunLimitsOverride;
  /** Delay before `openSession` answers, in milliseconds. */
  readonly openSessionDelayMs?: number;
  /** Replaces what the run API's interrupt does to the run (it still records the run it was asked to stop). */
  readonly interrupt?: (run: RunRecord, store: InMemoryRunStore) => Promise<void>;
  /** The run API has no interrupt at all. */
  readonly noInterrupt?: boolean;
  /** Opening a run's event stream fails with this, or reading it does, as a database outage would. */
  readonly streamError?: { readonly failure: Error; readonly when: 'open' | 'read' };
}

/** What the fake run API saw while an evaluation ran. */
interface Seen {
  readonly store: InMemoryRunStore;
  readonly playing: Promise<void>[];
  readonly recorded: unknown[];
  readonly interrupted: string[];
  /** The version each opened session pinned, and each preflight checked. */
  readonly pins: { session: (string | undefined)[]; preflight: (string | undefined)[] };
  /** The `outputSchema` each launched run was started with (`undefined` when it had none). */
  readonly schemas: (Readonly<Record<string, unknown>> | undefined)[];
  /** The `limits` each launched run was started with (`undefined` when it had none). */
  readonly limitsSeen: (RunLimitsOverride | undefined)[];
}

/** A run store whose event stream cannot be opened or, once opened, read. */
class UnreadableStreamStore extends InMemoryRunStore {
  constructor(
    private readonly broken: { readonly failure: Error; readonly when: 'open' | 'read' },
  ) {
    super();
  }
  override openStream(): Promise<RunStreamHandle | null> {
    const { failure, when } = this.broken;
    if (when === 'open') return Promise.reject(failure);
    return Promise.resolve({
      reset: null,
      events: {
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(failure) }),
      },
      close: () => undefined,
    });
  }
}

/** Plays the script for the run's prompt into `store`. */
async function playScript(store: InMemoryRunStore, { run, prompt }: LaunchContext): Promise<void> {
  const script = SCRIPTS[prompt];
  if (script === undefined || script === 'hang') return;
  for (const frame of script.frames) {
    await store.append(run.id, { type: frame.frame, data: frame });
  }
  if (script.pause !== undefined) {
    await store.markRunning(run.id);
    await store.awaitApproval(run.id, script.pause);
    return;
  }
  await store.finish(run.id, script.status, script.error ?? null, true, script.output ?? null);
}

/** The run API's interrupt, or none when `setup.noInterrupt`. */
function interruptFor(setup: Setup, { store, interrupted }: Seen): Partial<RunApiEnvironment> {
  if (setup.noInterrupt === true) return {};
  return {
    interruptRun: async (_principal: RunPrincipal, run: RunRecord) => {
      interrupted.push(run.id);
      if (setup.interrupt !== undefined) return setup.interrupt(run, store);
      await store.finish(run.id, 'cancelled', null, true);
    },
  };
}

function runApiFor(setup: Setup, seen: Seen): RunApiEnvironment {
  const { store, pins } = seen;
  return {
    authenticate: () => Promise.resolve(PRINCIPAL),
    findAgent: () =>
      Promise.resolve({ id: AGENT, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' }),
    openSession: async (_principal, agent, _requested, agentVersionId) => {
      pins.session.push(agentVersionId);
      if (setup.openSessionDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, setup.openSessionDelayMs));
      }
      return {
        id: crypto.randomUUID(),
        agentId: agent.id,
        engine: null,
        agentVersionId: agentVersionId ?? null,
      };
    },
    ownsRun: () => Promise.resolve(true),
    ...interruptFor(setup, seen),
    store,
    launch: (context) => {
      seen.schemas.push(context.outputSchema);
      seen.limitsSeen.push(context.limits);
      seen.playing.push(playScript(store, context));
    },
    recordEvaluation: (_principal, evaluation) => {
      seen.recorded.push(evaluation);
      return Promise.resolve({ id: EVALUATION_ID, createdAt: new Date('2026-10-04T00:00:00Z') });
    },
    ...(setup.judge === undefined ? {} : { judgeEvaluationCase: setup.judge }),
    // The five parameters are `RunApiEnvironment['preflight']`'s: the port fixes the arity.
    preflight: (principal, agent, sessionId, modelOverride, agentVersionId) => {
      pins.preflight.push(agentVersionId);
      return setup.preflight === undefined
        ? Promise.resolve(null)
        : setup.preflight(principal, agent, sessionId, modelOverride, agentVersionId);
    },
  };
}

function versionFor(): AgentVersionRecord {
  return {
    id: VERSION_ID,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    number: 7,
    summary: 'v7',
    via: 'aw-push',
    body: {},
    createdByPrincipalId: PRINCIPAL.principalId,
    createdAt: new Date(),
  };
}

export function setUp(setup: Setup = {}) {
  const store =
    setup.streamError === undefined
      ? new InMemoryRunStore()
      : new UnreadableStreamStore(setup.streamError);
  const seen: Seen = {
    store,
    playing: [],
    recorded: [],
    interrupted: [],
    pins: { session: [], preflight: [] },
    schemas: [],
    limitsSeen: [],
  };
  const version = versionFor();
  const dependencies: EvaluateAgentVersionDependencies = {
    store: { find: (_agentId, number) => Promise.resolve(number === 7 ? version : null) },
    runs: runApiFor(setup, seen),
    ...(setup.deadlineMs === undefined ? {} : { deadlineMs: setup.deadlineMs }),
    ...(setup.limits === undefined ? {} : { limits: setup.limits }),
  };
  const evaluate = async (body: unknown) => {
    const result = await evaluateAgentVersion(body, AGENT, PRINCIPAL, dependencies);
    await Promise.all(seen.playing);
    return result;
  };
  const { recorded, interrupted, pins, schemas, limitsSeen } = seen;
  return { evaluate, recorded, interrupted, pins, schemas, limitsSeen, store };
}

export const ORDER_CASE = {
  name: 'order status uses the tool',
  input: 'Where is order 1042?',
  expect: { tool: 'orders_getOrder', contains: ['shipped'] },
};
export const ORDER_CASE_AGAIN = { ...ORDER_CASE, name: 'order status again' };
export const REFUND_CASE = {
  name: 'no refund promises',
  input: 'I want my money back now',
  expect: { judge: 'Stays polite and does not promise a refund' },
};

export const DRAFT_SCHEMA = { type: 'object', properties: { width: { type: 'number' } } };
export const DRAFT_CASE = {
  name: 'the outline is 140 x 90',
  input: 'Draft the change set',
  outputSchema: DRAFT_SCHEMA,
  expect: { output: { width: 140, height: 90 } },
};

/** A judge reply that ended normally with `text`. */
export const judgeSays = (text: string) => Promise.resolve({ text, stopReason: 'end_turn' });

/** Each case's failures, in order, from an evaluation response. */
export function failuresOf(result: { readonly body: unknown }) {
  return EvaluationResourceSchema.parse(result.body).results.map((r) => r.failures);
}

/** `pending`, whose `settled()` fails unless it has already settled: no waiting on real time. */
export function settledAfter<T>(pending: Promise<T>) {
  let done = false;
  const mark = () => {
    done = true;
  };
  void pending.then(mark, mark);
  return {
    settled: () => {
      expect(done).toBe(true);
      return pending;
    },
  };
}
