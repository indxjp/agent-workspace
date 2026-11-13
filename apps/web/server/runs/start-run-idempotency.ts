/**
 * The start key of a run start (ADR-0151, #250) and the answers a start gives: the `202` for a new
 * run and for a replay, and the replay of a key that is already held.
 */
import { createHash } from 'node:crypto';

import { RUN_IDEMPOTENCY_PROBLEM_CODES } from '@indx-workspace/contracts/runs';

import type { RunPrincipal } from './environment';
import { apiError, json } from './http';
import { renderRun } from './run-resource';
import { MAX_IDEMPOTENCY_KEY_CHARS, type StartRunBody } from './service';
import type { RunIdempotency, RunRecord, RunStore } from './store';

/** What a team run start pins on the lead's run: the team version the run records. */
interface TeamVersionPin {
  readonly agentTeamVersionId: string;
}

/** The request header that carries a start key. */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** 202, not 201: the run is accepted and queued, and the caller wants its stream. */
const START_ACCEPTED_STATUS = 202;

/** A start's answer: `202` with the run and its stream URL, for a new run and a replay alike. */
export function acceptedStart(run: RunRecord): Response {
  const events = `/api/runs/${run.id}/events`;
  return json({ run: renderRun(run), events }, START_ACCEPTED_STATUS, { Location: events });
}

/** What a start key is bound to: who asks, for which agent (and team version), with what body. */
export interface StartKeyScope {
  readonly request: Request;
  readonly principal: RunPrincipal;
  readonly agentId: string;
  readonly body: StartRunBody;
  readonly team: TeamVersionPin | null;
}

/** `value` with every object's members sorted, so member order never changes a request's hash. */
function withSortedMembers(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1)),
  );
}

/**
 * The start key of this request: `undefined` when absent, `invalid`, or the key with the acting
 * principal and the SHA-256 of what was asked: the agent, the team version a team route pins (so a
 * key used on the lead's route and on a team's route are different requests, never a replay of one
 * as the other), and the parsed body's JSON with every object's members
 * sorted, so a retry that lists the same members in another order (an `outputSchema` rebuilt by
 * the client) is the same request. Arrays keep their order; it is part of what was asked.
 */
export function readIdempotencyKey(scope: StartKeyScope): RunIdempotency | 'invalid' | undefined {
  const header = scope.request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (header === null) return undefined;
  const key = header.trim();
  if (key === '' || key.length > MAX_IDEMPOTENCY_KEY_CHARS) return 'invalid';
  const asked = JSON.stringify(
    {
      agentId: scope.agentId,
      teamVersionId: scope.team?.agentTeamVersionId ?? null,
      body: scope.body,
    },
    withSortedMembers,
  );
  const requestHash = createHash('sha256').update(asked).digest('hex');
  return { principalId: scope.principal.principalId, key, requestHash };
}

/**
 * The answer to a start whose key is already held: the original run whatever its status — a
 * paused run never frees its key — or `409 run_idempotency_conflict` for a different request.
 * `null` when the key is not held.
 */
export async function replayStart(
  store: RunStore,
  principal: RunPrincipal,
  idempotency: RunIdempotency,
): Promise<Response | null> {
  const held = await store.findByIdempotencyKey(
    principal.workspaceId,
    idempotency.principalId,
    idempotency.key,
  );
  if (held === null) return null;
  if (held.requestHash !== idempotency.requestHash) {
    return apiError(
      RUN_IDEMPOTENCY_PROBLEM_CODES.run_idempotency_conflict,
      'run_idempotency_conflict',
      'this Idempotency-Key was already used with a different request; send a new key.',
    );
  }
  return acceptedStart(held.run);
}
