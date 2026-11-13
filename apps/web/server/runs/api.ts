/**
 * The §34 run endpoints, as plain `Request` → `Response` functions.
 *
 * ```text
 * POST /api/agents/:id/runs        startRun
 * GET  /api/runs                   listRuns          (issue #135)
 * GET  /api/runs/:id               readRun
 * GET  /api/runs/:id/events        streamRunEvents
 * POST /api/runs/:id/interrupt     interruptRun      (issue #235, S-14)
 * POST /api/runs/:id/revoke-tokens revokeRunTokens   (issue #235, S-15; same handler as the
 *                                                      deprecated POST /api/runs/:id)
 * ```
 *
 * The App Router files under `apps/web/app/api/**` are five-line adapters over these, for two
 * reasons: the whole surface is testable without a server, and §34's "expose a very small
 * control-plane API" stays legible as one file rather than as three route handlers that have to
 * be diffed against each other.
 *
 * Every handler is ordered the same way, and the order is the point: configured → authenticated
 * → well-formed → authorised → found. Each step is a positive assertion that fails closed, and a
 * step that cannot run answers with its own status rather than falling through to the next
 * (ADR-0015).
 *
 * `listRuns` and `readRun` render every item through the same {@link renderRun} (issue #135's
 * "list and detail cannot drift"), and share the same authorisation shape: `decide()` against
 * spec §21's `runs` classification in `apps/web/server/rbac/core/permissions.ts` — a grant of `any`
 * lists the whole workspace, and any narrower grant is enforced by filtering on the session's
 * exact owning principal, since `decide()` itself only tells a collection route that the caller "owes the
 * result set the filter" (`rbac/decide.ts`'s own comment on `not-applicable` ownership).
 * `permissions.ts` gives Owner **and Admin** `any` and Builder/Viewer `own`, so an Admin's
 * `GET /api/runs` is the workspace-wide history issue #135 asks for and `?user=<id>` is offered to
 * both roles. Admin reached `any` by issue #165, which widened that one cell and needed no edit
 * here — every branch below reads the *grant* `decide()` returned, never the role name — closing
 * gap G-7 of `docs/adr/W9-RUNS-135-durable-run-list.md`. See
 * `docs/adr/W9-AUTH-165-admin-reads-workspace-run-history.md`.
 *
 * The handlers' parts live beside this file — the body in `start-run-body.ts`, the rendered run in
 * `run-resource.ts`, who may reach a run in `access.ts` and the start in `start-run.ts` — and are
 * re-exported here, so `runs/api` stays the one import path for every caller.
 */
import { RUN_CHILDREN_MAX } from '@indx-workspace/contracts/runs';

import {
  decideRunListAccess,
  findAuthorisedRun,
  findRunForPrincipal,
  invalidRunId,
  notConfigured,
  requireRunPermission,
  runNotFound,
  unauthenticated,
} from './access';
import { forVisitor, upgradeEventStream, type ResumedWithinRow } from './agent-frames';
import { withoutRunDirectory } from './host-paths';
import { readResumeCursor, type ResumeCursor } from './cursor';
import { getRunApi, type RunPrincipal, type RunApiEnvironment } from './environment';
import { featureRefusalResponse } from '../features/guard';
import { apiError, isUuid, json, readJsonBody } from './http';
import { encodeRunListCursor, parseRunListQuery } from './list-query';
import { renderRun, renderRunDetail } from './run-resource';
import { sseStreamResponse, type SseControlFrame, type StreamOutcome } from './sse';
import { startAuthorisedRun } from './start-run';
import { isTerminalRunStatus, type RunRecord, type RunStreamHandle } from './store';
import { resolveAgentRunOwnership } from '../agents/run-ownership';

export {
  findRunForPrincipal,
  notConfigured,
  refuseOverVisitorLimit,
  requireRunPermission,
  requireSessionScopeMatch,
  unauthenticated,
} from './access';
export { renderRun, renderRunDetail } from './run-resource';
export { parseStartRunBody } from './start-run-body';
export { startAuthorisedRun } from './start-run';

/** POST /api/agents/:id/runs */
export async function startRun(request: Request, agentId: string): Promise<Response> {
  const env = getRunApi();
  if (env === null) return notConfigured();

  const principal = await env.authenticate(request);
  if (principal === null) return unauthenticated();
  if (!isUuid(agentId)) {
    return apiError(400, 'invalid_agent_id', 'the agent id in the path is not a UUID.');
  }
  // issue #117 (W9-AUTH-117, declared out-of-globs on that task's PR): agents now carry
  // `created_by` and `agent_grants` exists, so ownership is real rather than always `'unknown'`.
  const ownership = await resolveAgentRunOwnership(principal, agentId);
  const permission = requireRunPermission(request, principal, ownership);
  if (permission !== null) return permission;
  return startAuthorisedRun({ request, env, principal }, agentId, null);
}

/** GET /api/runs/:id */
export async function readRun(request: Request, runId: string): Promise<Response> {
  const env = getRunApi();
  if (env === null) return notConfigured();
  const principal = await env.authenticate(request);
  if (principal === null) return unauthenticated();
  if (!isUuid(runId)) return invalidRunId();
  const found = await findAuthorisedRun({ request, env, principal }, runId, 'match-session');
  if (found.kind === 'refused') return found.response;
  return json({ run: await renderRunDetail(env.store, found.run) }, 200);
}

/**
 * GET /api/runs — a workspace-scoped, filtered, cursor-paginated run list (issue #135). Every
 * item is rendered by the exact {@link renderRun} `readRun` uses, so list and detail cannot drift.
 */
export async function listRuns(request: Request): Promise<Response> {
  const env = getRunApi();
  if (env === null) return notConfigured();
  const principal = await env.authenticate(request);
  if (principal === null) return unauthenticated();
  const disabled = await featureRefusalResponse(request, principal.workspaceId);
  if (disabled !== null) return disabled;

  const access = decideRunListAccess(request, principal);
  if (access.kind === 'denied') return access.response;

  const query = parseRunListQuery(new URL(request.url), access.grant, principal);
  if (query.kind === 'rejected') return apiError(query.status, query.code, query.reason);

  const page = await env.store.listRuns(principal.workspaceId, query.input);
  return json(
    {
      runs: page.items.map(renderRun),
      nextCursor: page.nextCursor === null ? null : encodeRunListCursor(page.nextCursor),
    },
    200,
  );
}

/** POST /api/runs/:id — owner/admin on-demand revocation of one or all run tokens. */
export async function revokeRunTokens(request: Request, runId: string): Promise<Response> {
  const env = getRunApi();
  if (env === null || env.revokeRunTokens === undefined) return notConfigured();
  const principal = await env.authenticate(request);
  if (principal === null) return unauthenticated();
  const permission = requireRunPermission(request, principal, 'not-applicable');
  if (permission !== null) return permission;
  if (!isUuid(runId)) return invalidRunId();
  const run = await findRunForPrincipal(env.store, principal, runId);
  if (run === null) return runNotFound(runId);

  const raw = await readJsonBody(request);
  if (raw.kind !== 'ok') return apiError(400, 'invalid_body', raw.reason);
  if (raw.value === null || typeof raw.value !== 'object' || Array.isArray(raw.value)) {
    return apiError(400, 'invalid_body', 'the request body must be a JSON object.');
  }
  const record = raw.value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'tokenId')) {
    return apiError(400, 'invalid_body', 'only tokenId may be supplied.');
  }
  const tokenId = record['tokenId'] ?? null;
  if (tokenId !== null && !isUuid(tokenId)) {
    return apiError(400, 'invalid_token_id', 'tokenId must be a UUID or null.');
  }
  const result = await env.revokeRunTokens(principal, runId, tokenId);
  return json(result, 200);
}

/**
 * Stop `run`, which the caller has already found and authorised: `'terminal'` when it had already
 * finished (nothing is interrupted), `'stopped'` after the interrupt was handed to the runtime.
 * The one interrupt path behind `POST /api/runs/:id/interrupt` and A2A `tasks/cancel`.
 */
export async function interruptRunFor(
  env: RunApiEnvironment,
  principal: RunPrincipal,
  run: RunRecord,
): Promise<'stopped' | 'terminal'> {
  const outcome = isTerminalRunStatus(run.status) ? 'terminal' : 'stopped';
  const interruptRun = env.interruptRun;
  if (interruptRun === undefined) {
    if (outcome === 'terminal') return outcome;
    throw new Error('the run API has no interruptRun installed');
  }
  if (outcome === 'stopped') await interruptRun(principal, run);
  // ADR-0104 acceptance decision 8: interrupting a team's lead run interrupts every live child
  // through the same durable path (#261, ADR-0151-FU-1440): each child's committed `cancelled`
  // status and token revocation, and the cancellation watch of the replica holding it. A child
  // never has children (depth at most 1), so one level is the whole tree.
  if (run.parentRunId === null || run.parentRunId === undefined) {
    const children = await env.store.listChildren(run.workspaceId, run.id, RUN_CHILDREN_MAX);
    await Promise.all(
      children
        .filter((child) => INTERRUPTIBLE_CHILD_STATUSES.has(child.status))
        .map((child) => interruptRun(principal, child)),
    );
  }
  return outcome;
}

/** The child statuses an interrupt of the root stops: every one that is not yet over. */
const INTERRUPTIBLE_CHILD_STATUSES: ReadonlySet<RunRecord['status']> = new Set([
  'queued',
  'running',
  'awaiting_approval',
]);

/**
 * POST /api/runs/:id/interrupt — issue #235 (S-14). Stop a run this principal may run.
 *
 * Ordered exactly like every other handler in this file (this file's own header): configured →
 * authenticated → well-formed → found → authorised → not-already-terminal → act → re-read. Found
 * before authorised, via {@link findRunForPrincipal}, so a run in another workspace answers the
 * same `404` a nonexistent one does (§25) rather than a `403` that would confirm it exists.
 */
export async function interruptRun(request: Request, runId: string): Promise<Response> {
  const env = getRunApi();
  if (env === null || env.interruptRun === undefined) return notConfigured();
  const principal = await env.authenticate(request);
  if (principal === null) return unauthenticated();
  if (!isUuid(runId)) return invalidRunId();
  // This handler has never compared a session scope with the run's session; kept as it is.
  const found = await findAuthorisedRun({ request, env, principal }, runId, 'not-checked');
  if (found.kind === 'refused') return found.response;
  const { run } = found;
  if ((await interruptRunFor(env, principal, run)) === 'terminal') {
    return apiError(
      409,
      'run_not_interruptible',
      `run ${runId} is already ${run.status} and cannot be interrupted.`,
    );
  }
  // Re-read rather than trust the request: the response reports the status the store actually
  // holds, which is what a follower observing `run.status` will also see.
  const settled = await findRunForPrincipal(env.store, principal, runId);
  return json({ run: renderRun(settled ?? run) }, 200);
}

/**
 * How a client learns that a run did not succeed.
 *
 * Total over {@link RunRecord.status}: every status has an arm, an absent record has an arm, and
 * the `default` reports rather than assumes. Only `completed` returns `succeeded`, which is the
 * only arm that lets the stream end with a bare `done` — a run is treated as successful because
 * its record says `completed`, never because nothing said otherwise (ADR-0015).
 *
 * `queued`/`running` are reachable when the subscription was closed before the run reached a
 * terminal status — a client disconnect, or a teardown. The stream is over either way, so the
 * client is told the outcome is unknown rather than told the run is over.
 */
export function classifyRunOutcome(run: RunRecord | null, runId: string): StreamOutcome {
  if (run === null) {
    return {
      kind: 'indeterminate',
      reason: `run ${runId} is no longer readable; its outcome is unknown to this connection`,
    };
  }
  switch (run.status) {
    case 'completed':
      return { kind: 'succeeded' };
    case 'failed':
      return {
        kind: 'failed',
        status: 'failed',
        message: run.error ?? `run ${runId} failed and recorded no message`,
      };
    case 'cancelled':
      return {
        kind: 'failed',
        status: 'cancelled',
        message: run.error ?? `run ${runId} was cancelled`,
      };
    case 'awaiting_approval':
      return { kind: 'paused' };
    case 'queued':
    case 'running':
      return {
        kind: 'indeterminate',
        reason: `the stream for run ${runId} ended while the run was still ${run.status}; its outcome is unknown to this connection`,
      };
    default: {
      // Unreachable while `RunStatus` and this switch agree; a new status added to one and not
      // the other lands here and is reported, not silently treated as a success.
      const unhandled: never = run.status;
      return {
        kind: 'indeterminate',
        reason: `run ${runId} has a status this server does not recognise: ${String(unhandled)}`,
      };
    }
  }
}

/**
 * Where a resumed stream starts. A cursor that named a frame *inside* a row is resumed by
 * re-reading that whole row — the store seeks by row and cannot deliver half of one — and dropping
 * the frames the client already has. `id - 1n` is what re-reads it: `after` means "strictly
 * greater than". See `agent-frames.ts`.
 */
function resumeFrom(cursor: Exclude<ResumeCursor, { readonly kind: 'invalid' }>): {
  readonly resumedWithin: ResumedWithinRow | null;
  readonly after: bigint | null;
} {
  if (cursor.kind !== 'after') return { resumedWithin: null, after: null };
  if (cursor.subIndex === null) return { resumedWithin: null, after: cursor.id };
  const resumedWithin = { sequence: cursor.id, subIndex: cursor.subIndex };
  // Row 0 does not exist — sequences start at 1 — so "re-read row 0" is "from the beginning", and
  // saying so keeps a negative id out of the query.
  return { resumedWithin, after: resumedWithin.sequence === 0n ? null : cursor.id - 1n };
}

/**
 * ENG-03: the stream serves one vocabulary. A row recorded before it is upgraded here, on read,
 * into the neutral `agent.*` frames — never migrated in place. `agent-frames.ts` says why.
 * ADR-0145 D4: a session-scoped token is a visitor, and is never served operator-only fields.
 * UX-02 (#2086): the run's directory on the runtime host is masked in every frame.
 */
function framesFor(
  principal: RunPrincipal,
  handle: RunStreamHandle,
  resumedWithin: ResumedWithinRow | null,
  run: RunRecord,
): ReturnType<typeof withoutRunDirectory> {
  const frames = withoutRunDirectory(upgradeEventStream(handle.events, resumedWithin), run);
  return principal.scope?.kind === 'session' ? forVisitor(frames) : frames;
}

/**
 * GET /api/runs/:id/events
 *
 * The one endpoint whose error handling is genuinely awkward, and the awkwardness is stated
 * rather than smoothed over: any non-200 makes `EventSource` stop reconnecting forever (R-13
 * finding 7). So every *pre-flight* failure below is a non-200 on purpose — the client is not yet
 * established and a permanent stop is the honest outcome for a request that can never succeed as
 * written — while every failure *after* the response has begun travels in band as a `run-failed`
 * frame. See `docs/adr/W1-CP-04-resume-cursor-failures.md`.
 *
 * The `outcome` callback below is the other half of that sentence: a run that *itself* failed is
 * also reported in band, as a `run-failed` frame written just before `done`. A stream that ends
 * cleanly is not a run that succeeded — see
 * `docs/adr/W1-CP-04-a-finished-stream-is-not-a-finished-run.md`.
 */
export async function streamRunEvents(request: Request, runId: string): Promise<Response> {
  const env = getRunApi();
  if (env === null) return notConfigured();
  const principal = await env.authenticate(request);
  if (principal === null) return unauthenticated();
  if (!isUuid(runId)) return invalidRunId();

  const cursor = readResumeCursor(
    request.headers.get('last-event-id'),
    new URL(request.url).searchParams.get('after'),
  );
  if (cursor.kind === 'invalid') {
    // NOT a silent restart from the beginning. A client that believes it is resuming and is sent
    // the whole log again renders every event twice and never learns why.
    return apiError(400, 'invalid_resume_cursor', cursor.reason);
  }

  const found = await findAuthorisedRun({ request, env, principal }, runId, 'match-session');
  if (found.kind === 'refused') return found.response;

  const { resumedWithin, after } = resumeFrom(cursor);
  const handle = await env.store.openStream(runId, after);
  if (handle === null) return runNotFound(runId);

  const prelude: SseControlFrame[] =
    handle.reset === null ? [] : [{ name: 'stream-reset', data: handle.reset }];

  return sseStreamResponse({
    source: framesFor(principal, handle, resumedWithin, found.run),
    prelude,
    signal: request.signal,
    // Re-read the record after the source is exhausted rather than closing over the one fetched
    // above: the run's terminal status is written while the stream is open, so the copy from
    // before the stream started would still say `queued`. `findRunForPrincipal`, not a bare
    // `get`, so an outcome frame can never describe another workspace's run.
    outcome: async (): Promise<StreamOutcome> =>
      classifyRunOutcome(await findRunForPrincipal(env.store, principal, runId), runId),
    onTeardown: () => {
      handle.close();
    },
  });
}
