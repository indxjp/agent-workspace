import type { SessionRecord, SessionRepository } from '@agent-workspace/core/db';

import { publishedEngineId } from '../engines/session-engine';
import type { SessionRef } from '../runs/environment';

/**
 * Turn a persisted platform session into the engine launch mode its durable identity proves.
 *
 * A project session exists before its first run so attribution is fixed before history begins.
 * Such a row has no engine session id yet and must launch fresh. This lookup deliberately does not
 * claim one: the runner callback below records the identity only after an actual run reports it.
 *
 * `engine` and `agentVersionId` (issue #612) are carried across unchanged, `null` included. It is what the run routes compare the
 * agent's own engine against (`../engines/session-engine.ts`), and a session that has not been
 * pinned says so rather than being read as the platform's default engine.
 */
export function sessionForLaunch(session: SessionRecord): SessionRef {
  const ref = {
    id: session.id,
    agentId: session.agentId,
    engine: session.engine,
    agentVersionId: session.agentVersionId,
  };
  return session.engineSessionId === null ? ref : { ...ref, resume: true };
}

/**
 * Persist the identity reported by the runner, after refusing a mismatched engine session.
 *
 * `engine` is written in the **same update** as `engine_session_id`, not a later one. An engine
 * session id is reported *by* an engine, so a row that carries one must say which engine produced
 * it; splitting the two writes would leave a window in which it does not, and that window is
 * exactly the state the release's invariant (`engine IS NULL AND engine_session_id IS NOT NULL`
 * never holds) denies. Migration 0025 closes the same gap for rows written before this code.
 *
 * The engine is the one the **run** recorded, which `startRun` took from the session's pin or from
 * the agent's policy (ADR-0065 D8, `../engines/session-engine.ts`). Reading it off the run rather
 * than off the agent is what makes this a record of what happened: the policy may have been edited
 * while the run was in flight, and the id that was reported came from the engine that ran.
 *
 * A run with no engine is refused rather than pinned to a default. `RunRecord.engine` is absent or
 * `null` only for a run recorded before migration 0024 added the column, and such a run cannot be
 * the one reporting an identity now — so an empty value here is a defect in the caller, not a state
 * to guess at.
 */
export async function recordReportedSessionIdentity(
  sessions: SessionRepository,
  session: SessionRef,
  reportedSessionId: string,
  engine: string | null | undefined,
): Promise<void> {
  if (reportedSessionId !== session.id) {
    throw new Error('the runtime reported an engine session id that differs from the platform id');
  }
  if (engine === null || engine === undefined) {
    throw new Error('the run recorded no engine, so the session identity it reported names none');
  }
  const outcome = await sessions.update(session.id, {
    engineIdentity: { engineSessionId: reportedSessionId, engine: publishedEngineId(engine) },
  });
  if (outcome.kind === 'not-found') {
    throw new Error('the session disappeared before its engine identity could be recorded');
  }
}
