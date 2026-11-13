/**
 * The scripted platform of the recipe harness (issue #1513): a `fetchDouble` that answers the
 * run routes a recipe uses, with each agent's runs taken from its script in order.
 *
 * Run start honours `Idempotency-Key` the way the platform does (ADR-0151, #1439): the same key
 * and the same body answer the run the first start created, whatever its status; the same key with
 * another body is `409 run_idempotency_conflict`. A decision on a paused run starts its
 * continuation from the agent's script (ADR-0145); a paused run can be decided "in the console"
 * or expire, as the platform would.
 */
import type { RunApprovalCall, RunResource } from '@indx-workspace/contracts/runs';
import {
  eventStreamResponse,
  fetchDouble,
  fixtures,
  jsonResponse,
  type FetchDouble,
  type RecordedRequest,
} from '@indx-workspace/sdk/testing';

import type { Json } from '../recipe.js';

/** One scripted outcome of an agent's run. */
export type ScriptedOutcome =
  | { readonly kind: 'completed'; readonly output: Json }
  | { readonly kind: 'awaitingApproval'; readonly call: RunApprovalCall }
  | { readonly kind: 'failed'; readonly code: string };

/** An agent's runs, in the order they start (a continuation counts as a run). */
export type Script = readonly ScriptedOutcome[];

/** The run completes; a string is its text, anything else its structured answer. */
export function completed(output: Json): ScriptedOutcome {
  return { kind: 'completed', output };
}

/** The run stops for approval of `call`. */
export function awaitingApproval(
  call: RunApprovalCall = { toolName: 'send_email', canonicalCall: 'send_email({})' },
): ScriptedOutcome {
  return { kind: 'awaitingApproval', call };
}

/**
 * The run fails with `code`. The stored error also carries text a provider might have written,
 * which a recipe must never store.
 */
export function failed(code: string): ScriptedOutcome {
  return { kind: 'failed', code };
}

/** What a run's stored error says beside its code, standing in for a provider's text. */
export const PROVIDER_TEXT = 'upstream said: quota exceeded for org-7 (request req_9f2)';

const APPROVAL_EXPIRED_ERROR =
  'approval_expired: no decision was made within 24 hours, so the request was rejected';

export interface ScriptedPlatform {
  readonly double: FetchDouble;
  /** Every `POST /api/agents/:id/runs` the platform received, replays included. */
  runsStarted(): readonly RecordedRequest[];
  /** Every run the platform created, in order. */
  runs(): readonly RunResource[];
  /** Decides a paused run as the console would, without the app knowing its continuation. */
  decideOutside(runId: string): void;
  /** Lets a paused run's approval expire (ADR-0145 D2.4). */
  expire(runId: string): void;
}

const problem = (status: number, code: string): Response =>
  jsonResponse(status, { error: { code, message: code } });

/** The scripted platform of {@link Script}s for `workspaceId`. */
export function scriptedPlatform(
  workspaceId: string,
  agents: Readonly<Record<string, Script>>,
): ScriptedPlatform {
  const runs = new Map<string, RunResource>();
  const keys = new Map<string, { readonly body: string; readonly runId: string }>();
  const used = new Map<string, number>();
  const expired = new Set<string>();

  const create = (agentId: string, sessionId: string): RunResource | undefined => {
    const script = agents[agentId];
    const index = used.get(agentId) ?? 0;
    const outcome = script?.[index];
    if (outcome === undefined) return undefined;
    used.set(agentId, index + 1);
    const base = { id: crypto.randomUUID(), workspaceId, agentId, sessionId };
    const run =
      outcome.kind === 'completed'
        ? fixtures.run({
            ...base,
            status: 'completed',
            output:
              typeof outcome.output === 'string'
                ? { text: outcome.output, structured: null }
                : { text: JSON.stringify(outcome.output), structured: outcome.output },
          })
        : outcome.kind === 'failed'
          ? fixtures.run({ ...base, status: 'failed', error: `${outcome.code}: ${PROVIDER_TEXT}` })
          : fixtures.run({ ...base, status: 'awaiting_approval', pendingApproval: outcome.call });
    runs.set(run.id, run);
    return run;
  };

  const start = (agentId: string, request: RecordedRequest): Response => {
    const key = request.headers.get('idempotency-key');
    const body = JSON.stringify(request.json);
    const held = key === null ? undefined : keys.get(key);
    if (held !== undefined) {
      if (held.body !== body) return problem(409, 'run_idempotency_conflict');
      const replay = runs.get(held.runId);
      return jsonResponse(202, { run: replay, events: `/api/runs/${held.runId}/events` });
    }
    const run = create(agentId, crypto.randomUUID());
    if (run === undefined) return problem(422, 'script_exhausted');
    if (key !== null) keys.set(key, { body, runId: run.id });
    return jsonResponse(202, { run, events: `/api/runs/${run.id}/events` });
  };

  const settlePaused = (
    run: RunResource,
    status: 'completed' | 'cancelled',
    error: string | null,
  ) => runs.set(run.id, { ...run, status, error, pendingApproval: null });

  const decide = (run: RunResource): Response => {
    if (expired.has(run.id)) return problem(409, 'approval_expired');
    if (run.status !== 'awaiting_approval') return problem(409, 'approval_already_decided');
    const continuation = create(run.agentId, run.sessionId);
    if (continuation === undefined) return problem(422, 'script_exhausted');
    settlePaused(run, 'completed', null);
    return jsonResponse(202, { run: continuation, events: `/api/runs/${continuation.id}/events` });
  };

  const route = (request: RecordedRequest): Response => {
    const path = request.url.pathname;
    const startPath = /^\/api\/agents\/([^/]+)\/runs$/u.exec(path);
    if (startPath !== null && request.method === 'POST') return start(startPath[1] ?? '', request);
    const one = /^\/api\/runs\/([^/]+)(?:\/(events|approval))?$/u.exec(path);
    const run = one === null ? undefined : runs.get(one[1] ?? '');
    if (one === null || run === undefined) return problem(404, 'run_not_found');
    if (one[2] === 'events') return eventStreamResponse('event: done\ndata: null\n\n');
    if (one[2] === 'approval') return decide(run);
    return jsonResponse(200, { run: fixtures.runDetail(run) });
  };

  const double = fetchDouble(route);
  return {
    double,
    runsStarted: () =>
      double.calls.filter(
        (call) => call.method === 'POST' && /^\/api\/agents\/[^/]+\/runs$/u.test(call.url.pathname),
      ),
    runs: () => [...runs.values()],
    decideOutside(runId) {
      const run = runs.get(runId);
      if (run?.status === 'awaiting_approval') settlePaused(run, 'completed', null);
    },
    expire(runId) {
      const run = runs.get(runId);
      if (run?.status !== 'awaiting_approval') return;
      expired.add(runId);
      settlePaused(run, 'cancelled', APPROVAL_EXPIRED_ERROR);
    },
  };
}
