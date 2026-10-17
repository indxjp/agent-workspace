/**
 * Session engine pinning (ADR-0065 D8, ENG-02b): a session stays on the engine it started with.
 *
 * `sessions.engine` is NULL until a run pins it. The first run of a session may therefore use any
 * engine; every later run must use the same one, and a run for a different engine is refused with
 * `409 session_engine_mismatch` **before any run row exists**. Switching a live session to another
 * engine is a non-goal of the engine programme (#299): a session's history is that engine's — a
 * Claude transcript is not a pi session file — so re-pinning would silently invalidate the
 * resumption the session exists for.
 *
 * ## Why the check is here and not in one route
 *
 * Three call sites create a run row: `startRun` (`../runs/api.ts`), the public-share launch
 * (`../composition/register.ts`'s `runPublic`) and, once the runner reports an engine session id,
 * `../composition/session-launch.ts` writes the pin. All three read this module, so the refusal is
 * one decision with three callers rather than three copies of a comparison. `../runs/api.ts` may not
 * import the composition root, which is the other reason it is not in `session-launch.ts` itself.
 *
 * ## Why the ids are `string`
 *
 * `EngineId` publishes one member, so a comparison between two `EngineId`s is trivially equal and a
 * mismatch would be unreachable — including in a test. The refs the run routes pass carry the engine
 * as a `string` for the same reason `RegisteredEngine.id` does (`./registry.ts`): a refusal that
 * cannot be reached is a refusal that is not proved. {@link publishedEngineId} narrows once, at the
 * point a value has to be *recorded*, with the same positive assertion `parseEngineId`
 * (`packages/core/src/db/repositories/runs.ts`) uses when it reads the column back.
 */
import { DEFAULT_ENGINE_ID, ENGINE_IDS, type EngineId } from '@indx-workspace/contracts/engines';

/**
 * The engine an agent with no stored policy runs on.
 *
 * `agents.policy` is NULL until a `PUT` writes one, and the policy a `GET` then answers is
 * `compiledPolicyFor`'s — whose arm is this engine. So this is the same default read twice, not a
 * fallback invented here.
 */
export { DEFAULT_ENGINE_ID };

/** The engine an agent's stored policy names, or {@link DEFAULT_ENGINE_ID} for a NULL column. */
export function engineForStoredPolicy(policy: { readonly engine: EngineId } | null): EngineId {
  return policy?.engine ?? DEFAULT_ENGINE_ID;
}

/**
 * Narrow an engine id to one the contracts publish.
 *
 * Throws rather than refusing, because there is no client mistake to report: a stored policy only
 * parses with a published engine (`AgentStoredPolicy`, `packages/core/src/db/schema/agents.ts`), so
 * a value outside `ENGINE_IDS` reaching here means whatever produced the reference is wrong, not
 * that the request was. Reported rather than defaulted (ADR-0015): recording `claude-agent-sdk` for
 * a run some other engine performed would make a guess indistinguishable from a measurement.
 */
export function publishedEngineId(value: string): EngineId {
  if (!(ENGINE_IDS as readonly string[]).includes(value)) {
    throw new Error(
      `the engine ${JSON.stringify(value)} is not one this platform's contracts publish, so no run or session can record it`,
    );
  }
  return value as EngineId;
}

/**
 * The outcome of comparing a session's pinned engine with the engine an agent wants to run on.
 *
 * `pinned` carries the engine the run must record: the session's, when it has one, and the agent's
 * when the session is about to be pinned by this very run. A caller never has to decide which.
 */
export type SessionEnginePin =
  | { readonly kind: 'pinned'; readonly engine: EngineId }
  | {
      readonly kind: 'mismatch';
      /** The engine the session is pinned to, and keeps. */
      readonly sessionEngine: string;
      /** The engine the agent's current policy names. */
      readonly agentEngine: string;
    };

/**
 * Decide whether `agentEngine` may run in a session pinned to `sessionEngine`.
 *
 * `sessionEngine` is `null` for a session no run has pinned yet — a project session created before
 * its first run, or one whose runs never reached the runner. Such a session accepts any engine, and
 * the answer names the agent's.
 */
export function pinSessionEngine(input: {
  readonly sessionEngine: string | null;
  readonly agentEngine: string;
}): SessionEnginePin {
  const { sessionEngine, agentEngine } = input;
  if (sessionEngine === null) {
    return { kind: 'pinned', engine: publishedEngineId(agentEngine) };
  }
  if (sessionEngine !== agentEngine) {
    return { kind: 'mismatch', sessionEngine, agentEngine };
  }
  return { kind: 'pinned', engine: publishedEngineId(sessionEngine) };
}

/** The sentence a `session_engine_mismatch` refusal explains itself with. */
export function sessionEngineMismatchMessage(mismatch: {
  readonly sessionEngine: string;
  readonly agentEngine: string;
}): string {
  return (
    `this session runs on the engine '${mismatch.sessionEngine}' and the agent's policy now names ` +
    `'${mismatch.agentEngine}'. A session stays on the engine it started with; omit sessionId to ` +
    'start a new session on the new engine.'
  );
}
