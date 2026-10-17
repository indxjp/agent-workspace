/**
 * A surface visitor's abuse limits (issue #622; #606 for ratings): per client on opening a
 * session, and per visitor session and per client on turns and ratings, plus a cap on the turns
 * one conversation may send. A refusal is a typed `429` (`SURFACE_LIMIT_PROBLEM_CODES`).
 *
 * The counters are `../../http/rate-limit.ts`'s, keyed the same way as `aw login`'s: a client is
 * its proxy-authenticated address, or the shared bucket without `AW_TRUSTED_PROXY_HOPS`. A visitor
 * session is the token's scoped session id, so resuming or re-minting cannot reset its counts.
 *
 * ponytail: per-process counters; several replicas each admit their own limit and a restart resets
 * turn counts — PostgreSQL counters (or `shares/runnable/service.ts`'s per-visitor limiter) when
 * the control plane runs more than one replica.
 */
import type {
  SurfaceDefinition,
  SurfaceLimitProblemCode,
} from '@indx-workspace/contracts/surfaces';

import {
  admitClient,
  BoundedRecencyMap,
  CLIENT_MEMORY,
  FixedWindowLimiter,
  MINUTE_MS,
  type Admission,
} from '../../http/rate-limit';
import { currentSurfaceSessionsRuntime } from './runtime';

/** Per minute: sessions per client, and turns and ratings per visitor session and per client. */
export const SURFACE_RATE_LIMITS = {
  sessionsPerClient: 10,
  turnsPerSession: 10,
  turnsPerClient: 60,
  feedbackPerSession: 30,
  feedbackPerClient: 120,
} as const;

/** The turn cap of a surface with `allowedOrigins` and no `limits.turnsPerConversation`. */
export const DEFAULT_TURNS_PER_CONVERSATION = 50;

/** A visitor write {@link admitVisitorWrite} refused. */
export interface SurfaceLimitRefusal {
  readonly code: SurfaceLimitProblemCode;
  readonly message: string;
  /** Seconds until the window resets; `null` for a refusal that waiting does not lift. */
  readonly retryAfterSeconds: number | null;
}

/** A turn or a rating of a run. */
export type VisitorWriteKind = 'turn' | 'feedback';

type Environment = Readonly<Record<string, string | undefined>>;

const limiter = (limit: number): FixedWindowLimiter =>
  new FixedWindowLimiter({ limit, windowMs: MINUTE_MS, capacity: CLIENT_MEMORY });

const sessionsByClient = limiter(SURFACE_RATE_LIMITS.sessionsPerClient);
const turnsBySession = limiter(SURFACE_RATE_LIMITS.turnsPerSession);
const turnsByClient = limiter(SURFACE_RATE_LIMITS.turnsPerClient);
const feedbackBySession = limiter(SURFACE_RATE_LIMITS.feedbackPerSession);
const feedbackByClient = limiter(SURFACE_RATE_LIMITS.feedbackPerClient);
/** Admitted turns per visitor session. */
const turnCounts = new BoundedRecencyMap<number>(CLIENT_MEMORY);

function rateLimited(retryAfterSeconds: number): SurfaceLimitRefusal {
  return {
    code: 'surface_rate_limited',
    message: 'Too many requests from this visitor. Try again shortly.',
    retryAfterSeconds,
  };
}

/** The turn cap of `surface`: its own, the default when it lists origins, or none. */
export function turnsPerConversation(surface: SurfaceDefinition): number | null {
  const declared = surface.limits?.turnsPerConversation;
  if (declared !== undefined) return declared;
  return surface.allowedOrigins === undefined ? null : DEFAULT_TURNS_PER_CONVERSATION;
}

/** Admit one session opened by the client `headers` identify, or say when to retry. */
export function admitSurfaceSession(
  headers: Headers,
  nowMs: number = Date.now(),
  env: Environment = process.env,
): Admission {
  return admitClient(sessionsByClient, SURFACE_RATE_LIMITS.sessionsPerClient, headers, nowMs, env);
}

/**
 * Admit one turn or rating of visitor session `sessionId` on `surface` (`null` when the surface
 * no longer resolves, which keeps the rate limits and the default cap), or refuse it. A turn past
 * the cap is refused before any rate counter moves, and only an admitted turn is counted.
 */
export function admitVisitorWrite(
  surface: SurfaceDefinition | null,
  sessionId: string,
  kind: VisitorWriteKind,
  headers: Headers,
  nowMs: number = Date.now(),
  env: Environment = process.env,
): SurfaceLimitRefusal | null {
  if (kind === 'feedback') {
    const bySession = feedbackBySession.admit(sessionId, nowMs);
    if (!bySession.admitted) return rateLimited(bySession.retryAfterSeconds);
    const byClient = admitClient(
      feedbackByClient,
      SURFACE_RATE_LIMITS.feedbackPerClient,
      headers,
      nowMs,
      env,
    );
    return byClient.admitted ? null : rateLimited(byClient.retryAfterSeconds);
  }
  const cap = surface === null ? DEFAULT_TURNS_PER_CONVERSATION : turnsPerConversation(surface);
  const sent = turnCounts.get(sessionId) ?? 0;
  if (cap !== null && sent >= cap) {
    return {
      code: 'surface_turn_limit_reached',
      message: 'This conversation has reached its message limit.',
      retryAfterSeconds: null,
    };
  }
  const bySession = turnsBySession.admit(sessionId, nowMs);
  if (!bySession.admitted) return rateLimited(bySession.retryAfterSeconds);
  const byClient = admitClient(
    turnsByClient,
    SURFACE_RATE_LIMITS.turnsPerClient,
    headers,
    nowMs,
    env,
  );
  if (!byClient.admitted) return rateLimited(byClient.retryAfterSeconds);
  turnCounts.set(sessionId, sent + 1);
  return null;
}

/**
 * The run API's `admitVisitorWrite` (issue #622): limit a turn or rating only when `sessionId` was
 * opened by the surface bootstrap. A session-scoped token minted through `POST /api/tokens` is a
 * customer backend's, not a visitor's, and is not limited here.
 */
export async function admitSurfaceVisitorWrite(
  workspaceId: string,
  sessionId: string,
  kind: VisitorWriteKind,
  headers: Headers,
): Promise<SurfaceLimitRefusal | null> {
  const visitor = await currentSurfaceSessionsRuntime()?.visitorSurface(workspaceId, sessionId);
  if (visitor === undefined || visitor === null) return null;
  return admitVisitorWrite(visitor.surface, sessionId, kind, headers);
}

/** Forget every count. Tests only. */
export function resetSurfaceLimits(): void {
  for (const each of [
    sessionsByClient,
    turnsBySession,
    turnsByClient,
    feedbackBySession,
    feedbackByClient,
  ]) {
    each.clear();
  }
  turnCounts.clear();
}
