import { log } from '../telemetry/logger';
import { ENGINE_CATALOGUE } from '@indx-workspace/contracts/engines';
import { ProjectPolicyLimitsSchema } from '@indx-workspace/contracts/policy-ceiling';
import {
  RUN_APPROVAL_PROBLEM_CODES,
  RUN_START_PROBLEM_CODES,
} from '@indx-workspace/contracts/runs';

import { engineIsInstalled, engineNotInstalledMessage } from '../engines/images';
import { pinSessionEngine, sessionEngineMismatchMessage } from '../engines/session-engine';
import { ownerPrincipalIdOf } from '../rbac/owner-principal';
import type { DailyCostCap } from '../usage/daily-cost';
import type {
  AgentRef,
  RunApiEnvironment,
  RunLimitsOverride,
  RunPrincipal,
  SessionRef,
} from './environment';
import { promptWithAttachments, type ResolvedAttachment } from './attachments';
import {
  ApprovalDecisionError,
  SessionBusyError,
  type ApprovalCall,
  type RunIdempotency,
  type RunRecord,
} from './store';
import { isAudioAttachment } from './transcription';

/**
 * The largest prompt one run may carry.
 *
 * The specification sets no limit. This is the smallest reading that still works: it is far above
 * any hand-typed message and far below anything that would let one unauthenticated-looking
 * request pin a control-plane process. See
 * `docs/adr/W1-CP-04-start-run-request-shape.md`.
 */
export const MAX_PROMPT_CHARS = 100_000;

/** The JSON body of `POST /api/agents/:id/runs`. */
export interface StartRunBody {
  readonly prompt: string;
  /** Continue an existing session, or omit to start one (spec §19.5 rule 4). */
  readonly sessionId: string | null;
  /**
   * Override the agent's default without mutating its definition (spec §48). Issue #129: a
   * connection and a model are supplied together or not at all — no layer of the resolution
   * ladder may mix a connection from one level with a model from another, and the run override is
   * the top of that ladder.
   */
  readonly modelOverride: { readonly connectionId: string; readonly model: string } | null;
  /** Run a new session on this numbered version instead of `local`'s (issue #697). */
  readonly version?: number;
  /** Workspace files granted to this run read-only (ADR-0146). Resolved by `resolveRunAttachments`. */
  readonly attachments?: readonly { readonly fileId: string }[];
  /** A JSON Schema the run must answer with (ADR-0143); already checked against its limits. */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /**
   * Makes this run the continuation of a paused run in `sessionId` (ADR-0145 D2.3): the paused run
   * is completed in the transaction that creates this one, and `approvedToolCalls` is what the
   * decision lets it run.
   */
  readonly decides?: {
    readonly runId: string;
    readonly approvedToolCalls: readonly ApprovalCall[];
  };
  /** The person an API-key caller acts for (ADR-0142 D2); `startRun` has already checked the caller. */
  readonly subject?: string;
  /** Narrows the run's file grants to these paths (issue #1539); judged by compose at launch. */
  readonly fileScope?: readonly string[];
}

/** A start {@link startRunOnSession} refused, with the status and code `startRun` answers. */
interface RunStartRefused {
  readonly kind: 'refused';
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: readonly string[];
}

export type RunOnSessionStart =
  | { readonly kind: 'started'; readonly run: RunRecord; readonly session: SessionRef }
  | RunStartRefused;

const refused = (
  status: number,
  code: string,
  message: string,
  details?: readonly string[],
): RunStartRefused => ({
  kind: 'refused',
  status,
  code,
  message,
  ...(details === undefined ? {} : { details }),
});

// ADR-0143: an engine that cannot honour a schema refuses the run rather than answering in prose
// the caller would parse as if it had been validated.
const structuredOutputUnsupported = (engine: string): RunStartRefused =>
  refused(
    422,
    'engine_capability_unsupported',
    `The engine '${engine}' does not support structuredOutput, so a run on it cannot take an outputSchema. Remove outputSchema or run an agent on an engine that supports it.`,
    ['structuredOutput'],
  );

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

const dailyCostCapRefusal = async (
  cap: DailyCostCap | undefined,
  workspaceId: string,
): Promise<RunStartRefused | null> => {
  if (cap === undefined) return null;
  let reached: Awaited<ReturnType<DailyCostCap['refusal']>>;
  try {
    reached = await cap.refusal(workspaceId);
  } catch (error) {
    // Fail-closed: a spend that cannot be read is not under the cap. Only the error name is logged.
    log.error('[runs] the daily cost cap could not be checked', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    return refused(
      RUN_START_PROBLEM_CODES.daily_cost_unavailable,
      'daily_cost_unavailable',
      'The workspace daily model cost could not be checked, so the run was not started. Try again shortly.',
    );
  }
  return reached === null
    ? null
    : refused(
        RUN_START_PROBLEM_CODES.daily_cost_cap_reached,
        'daily_cost_cap_reached',
        reached.unpricedUsage === true
          ? 'Some of the workspace model spend today has no price, so its daily cost cap cannot be measured; runs can start again after it resets.'
          : 'The workspace has reached its daily model cost cap; runs can start again after it resets.',
        [
          `capUsd: ${String(reached.capUsd)}`,
          `spentUsd: ${String(reached.spentUsd)}`,
          `resetsAt: ${reached.resetsAt}`,
          ...(reached.unpricedUsage === true ? ['unpricedUsage: true'] : []),
        ],
      );
};

const limitsRefusal = (limits: RunLimitsOverride | undefined): RunStartRefused | null =>
  limits === undefined || ProjectPolicyLimitsSchema.safeParse(limits).success
    ? null
    : refused(
        422,
        'invalid_run_limits',
        'A run limit must be a positive number (maxTurns a whole one).',
      );

/**
 * Start one run of `agent` for `principal`: the preflight, the session, the engine pin, the run row
 * and the launch. The one run starter behind `POST /api/agents/:id/runs` and the evaluation
 * handler (issue #618), so both meet the same refusals. The caller has already authenticated and
 * authorised the principal and found the agent; a refusal creates no run and opens no new session.
 * `agentVersionId` pins a new session to that version rather than `local`'s (issue #618).
 */
export async function startRunOnSession(
  env: RunApiEnvironment,
  principal: RunPrincipal,
  agent: AgentRef,
  input: Omit<StartRunBody, 'attachments'> & {
    readonly agentVersionId?: string;
    /** The caller's attachments after `resolveRunAttachments` authorised them. */
    readonly attachments?: readonly ResolvedAttachment[];
    /** The start key (ADR-0151); the run row holds it from the moment it is created. */
    readonly idempotency?: RunIdempotency;
    /**
     * Lowers this run's budget or turns below what its policy resolves; it never raises them. Set
     * only by trusted in-process callers: `parseStartRunBody` rejects it in a request body.
     */
    readonly limits?: RunLimitsOverride;
  },
): Promise<RunOnSessionStart> {
  const attachments = input.attachments ?? [];
  // Issue #393: a run whose agent has no runtime profile, or whose model cannot resolve, is refused
  // with a code that names the missing piece, before `store.create`. A run that would open a new
  // session is checked before `openSession` too (PR #403 review), so a refused first message leaves
  // no empty session behind. A follow-up in an existing session is checked below, once the session
  // is known to be usable, because its project default depends on that session.
  const checkRunStart = async (sessionId: string | null): Promise<RunStartRefused | null> => {
    const capReached = await dailyCostCapRefusal(env.dailyCostCap, principal.workspaceId);
    if (capReached !== null) return capReached;
    const badLimits = limitsRefusal(input.limits);
    if (badLimits !== null) return badLimits;
    const refusal =
      env.preflight === undefined
        ? null
        : await env.preflight(
            principal,
            agent,
            sessionId,
            input.modelOverride,
            sessionId === null ? input.agentVersionId : undefined,
            attachments.length,
            attachments.filter(isAudioAttachment).length,
            {
              attachments,
              ...(input.fileScope === undefined ? {} : { fileScope: input.fileScope }),
            },
          );
    return refusal === null
      ? null
      : refused(RUN_START_PROBLEM_CODES[refusal.code], refusal.code, refusal.message);
  };
  // Every refusal a run that opens its own session can meet is decided before that session is
  // opened (PR #403 review): the preflight, and the engine image and capabilities a new session
  // would pin (`pinSessionEngine` gives a session with no engine the agent's). So the only sessions this route
  // creates are ones a run is then created in. The one session it deletes is a new one whose run
  // insert failed (below); a session a client opened itself (`projects.startSession`) stays the
  // client's, refused start or not.
  if (input.sessionId === null) {
    const refusal = await checkRunStart(null);
    if (refusal !== null) return refusal;
    const fresh = pinSessionEngine({ sessionEngine: null, agentEngine: agent.engine });
    if (fresh.kind === 'pinned' && !engineIsInstalled(fresh.engine)) {
      return refused(422, 'engine_not_installed', engineNotInstalledMessage(fresh.engine));
    }
    if (
      fresh.kind === 'pinned' &&
      input.outputSchema !== undefined &&
      !ENGINE_CATALOGUE[fresh.engine].structuredOutput
    ) {
      return structuredOutputUnsupported(fresh.engine);
    }
  }

  const session = await env.openSession(
    principal,
    agent,
    input.sessionId,
    input.sessionId === null ? input.agentVersionId : undefined,
  );
  if (session === null) {
    return refused(
      409,
      'session_not_usable',
      'the requested session cannot run this agent; omit sessionId to start a new session (spec §19.5 rule 4).',
    );
  }

  // ADR-0065 D8: a session stays on the engine it started with. Checked *before* `store.create`,
  // so a refused run leaves no row behind — a queued run that can never be launched is worse than
  // no run, because it is indistinguishable from one the runtime has not reached yet.
  // A pinned session runs its version's engine, which may not be the agent row's (issue #612).
  const pin = pinSessionEngine({
    sessionEngine: session.engine,
    agentEngine: session.versionEngine ?? agent.engine,
  });
  if (pin.kind === 'mismatch') {
    return refused(409, 'session_engine_mismatch', sessionEngineMismatchMessage(pin));
  }

  // ENG-07 (#306): a run needs a sandbox, and a sandbox needs an image that carries this engine's
  // adapter. Checked here — after the engine is pinned and *before* `store.create` — for the reason
  // the pin above is: a queued run that can never be launched is worse than no run, because it is
  // indistinguishable from one the runtime has not reached yet. `installed` on `GET /api/engines`
  // reads the same map, so a client that checked the catalogue first never sees this.
  if (!engineIsInstalled(pin.engine)) {
    return refused(422, 'engine_not_installed', engineNotInstalledMessage(pin.engine));
  }

  if (input.outputSchema !== undefined && !ENGINE_CATALOGUE[pin.engine].structuredOutput) {
    return structuredOutputUnsupported(pin.engine);
  }

  // The follow-up's preflight (see `checkRunStart` above), before `store.create` for the reason the
  // checks above give.
  if (input.sessionId !== null) {
    const refusal = await checkRunStart(session.id);
    if (refusal !== null) return refusal;
  }

  let run: RunRecord;
  try {
    run = await env.store.create({
      id: crypto.randomUUID(),
      workspaceId: principal.workspaceId,
      agentId: agent.id,
      sessionId: session.id,
      initiatingUserId: principal.userId,
      ownerPrincipalId: ownerPrincipalIdOf(principal),
      agentVersion: session.agentVersionNumber ?? null,
      // The engine the session is pinned to, or — for a session this run is the first of — the
      // one the agent's policy names. A record, never a default (ADR-0065).
      engine: pin.engine,
      prompt: input.prompt,
      ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      ...(input.idempotency === undefined ? {} : { idempotency: input.idempotency }),
      ...(input.decides === undefined
        ? {}
        : { decides: input.decides.runId, approvedToolCalls: input.decides.approvedToolCalls }),
    });
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
    if (error instanceof ApprovalDecisionError) {
      return error.reason === 'expired'
        ? refused(
            RUN_APPROVAL_PROBLEM_CODES.approval_expired,
            'approval_expired',
            `run ${error.runId} waited more than 24 hours for a decision; it was cancelled.`,
          )
        : refused(
            RUN_APPROVAL_PROBLEM_CODES.approval_already_decided,
            'approval_already_decided',
            `run ${error.runId} is no longer awaiting approval; it was already decided or stopped.`,
          );
    }
    // Two runs resuming one engine session would interleave its transcript.
    if (!(error instanceof SessionBusyError)) throw error;
    return refused(
      409,
      'session_busy',
      'this session already has a run in progress; wait for it to finish or interrupt it.',
    );
  }
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
  return { kind: 'started', run, session };
}
