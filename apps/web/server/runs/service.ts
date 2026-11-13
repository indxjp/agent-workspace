import type { Usd } from '../newtypes';
import { randomIds } from '../ids';
import { log } from '../telemetry/logger';
import type { RunStartInput, StartRunBody } from './start-input';
import { createRefusal, type RunStartRefused } from './start-refusal';
import { prepareSessionForRun } from './start-session';
export type { StartRunBody } from './start-input';

import { ownerPrincipalIdOf } from '../identity';
import { promptWithAttachments } from './attachments';
import type {
  AgentRef,
  RunReadEnvironment,
  RunStartEnvironment,
  RunLimitsOverride,
  RunPrincipal,
  SessionRef,
} from './environment';
import { type CreateRunInput, type RunRecord } from './store';

/**
 * The largest prompt one run may carry.
 *
 * The specification sets no limit. This is the smallest reading that still works: it is far above
 * any hand-typed message and far below anything that would let one unauthenticated-looking
 * request pin a control-plane process. See
 * `docs/adr/W1-CP-04-start-run-request-shape.md`.
 */
export const MAX_PROMPT_CHARS = 100_000;

/** The longest `Idempotency-Key` a run start accepts; the run route and a Builder trial share it. */
export const MAX_IDEMPOTENCY_KEY_CHARS = 255;

export type RunOnSessionStart =
  | { readonly kind: 'started'; readonly run: RunRecord; readonly session: SessionRef }
  | RunStartRefused;

/** The start fields the launch carries, whether or not the run row also stores them. */
function launchOnlyContext(
  input: Pick<StartRunBody, 'outputSchema' | 'subject' | 'fileScope'> & {
    readonly limits?: RunLimitsOverride;
  },
): Pick<StartRunBody, 'outputSchema' | 'subject' | 'fileScope'> & {
  readonly limits?: RunLimitsOverride;
} {
  return {
    ...(input.limits === undefined ? {} : { limits: input.limits }),
    ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    ...(input.subject === undefined ? {} : { subject: input.subject }),
    ...(input.fileScope === undefined ? {} : { fileScope: input.fileScope }),
  };
}

/** The start fields the run row stores, so a continuation built from the row alone can carry them on. */
function storedStartFields(
  input: Pick<StartRunBody, 'outputSchema' | 'subject'> & { readonly limits?: RunLimitsOverride },
): Pick<CreateRunInput, 'outputSchema' | 'subject' | 'limitsOverride'> {
  return {
    ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    ...(input.subject === undefined ? {} : { subject: input.subject }),
    ...(input.limits === undefined ? {} : { limitsOverride: input.limits }),
  };
}

/**
 * Start one run of `agent` for `principal`: the preflight, the session, the engine pin, the run row
 * and the launch. The one run starter behind `POST /api/agents/:id/runs` and the evaluation
 * handler (issue #618), so both meet the same refusals. The caller has already authenticated and
 * authorised the principal and found the agent; a refusal creates no run and opens no new session.
 * `agentVersionId` pins a new session to that version rather than `local`'s (issue #618).
 */
export async function startRunOnSession(
  env: RunReadEnvironment & RunStartEnvironment,
  principal: RunPrincipal,
  agent: AgentRef,
  input: RunStartInput,
): Promise<RunOnSessionStart> {
  const context = { env, principal, agent, input };
  const prepared = await prepareSessionForRun(context);
  if (prepared.kind === 'refused') return prepared;
  const { session, engine, spendCeilingUsd } = prepared;

  let run: RunRecord;
  try {
    run = await env.store.create(runInsert({ ...context, session }, engine, spendCeilingUsd));
  } catch (error) {
    // The session this call opened has no run in it now. It is removed only if it still has none: a
    // run that committed before the failure keeps its session.
    if (input.sessionId === null && env.discardSession !== undefined) {
      await env.discardSession(principal, session.id).catch((discardError: unknown) => {
        log.error('[runs] could not discard the session opened for a failed start', {
          error: discardError,
        });
      });
    }
    return createRefusal(error);
  }
  handoffQueuedRun({ ...context, session }, run);
  return { kind: 'started', run, session };
}

interface SessionRunContext {
  readonly env: RunReadEnvironment & RunStartEnvironment;
  readonly principal: RunPrincipal;
  readonly agent: AgentRef;
  readonly input: RunStartInput;
  readonly session: SessionRef;
}

function runInsert(
  { env, principal, agent, input, session }: SessionRunContext,
  engine: CreateRunInput['engine'],
  spendCeilingUsd: Usd | null,
): CreateRunInput {
  return {
    id: (env.ids ?? randomIds).newId(),
    workspaceId: principal.workspaceId,
    agentId: agent.id,
    sessionId: session.id,
    initiatingUserId: principal.userId,
    ownerPrincipalId: ownerPrincipalIdOf(principal),
    agentVersion: session.agentVersionNumber ?? null,
    // The engine the session is pinned to, or — for a session this run is the first of — the
    // one the agent's policy names. A record, never a default (ADR-0065).
    engine,
    prompt: input.prompt,
    ...storedStartFields(input),
    ...(input.idempotency === undefined ? {} : { idempotency: input.idempotency }),
    ...(input.decides === undefined
      ? {}
      : { decides: input.decides.runId, approvedToolCalls: input.decides.approvedToolCalls }),
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    ...(input.agentTeamVersionId === undefined
      ? {}
      : { agentTeamVersionId: input.agentTeamVersionId }),
    ...(spendCeilingUsd === null ? {} : { spendCeilingUsd }),
  };
}

function handoffQueuedRun(
  { env, principal, agent, input, session }: SessionRunContext,
  run: RunRecord,
): void {
  const attachments = input.attachments ?? [];
  // RF-303 (ADR-0151): the committed `queued` row is the acceptance, not the launch callback. A
  // handoff that throws leaves the run queued, where the stale-run sweep (`stale-sweep.ts`) ends it,
  // so the caller still gets the run it can watch rather than a 500 for a run that exists.
  try {
    env.launch({
      run,
      agent,
      session,
      principal,
      prompt: promptWithAttachments(input.prompt, attachments),
      modelOverride: input.modelOverride,
      ...(attachments.length === 0 ? {} : { attachments }),
      ...launchOnlyContext(input),
    });
  } catch (error) {
    env.logger?.error('the launch handoff failed; the run stays queued', { runId: run.id, error });
  }
}
