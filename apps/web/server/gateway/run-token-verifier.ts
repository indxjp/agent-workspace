import { createHash } from 'node:crypto';

import type { RunStatus } from '@indx-workspace/contracts/runs';
import type { RunTokenClaims, RunTokenCodec } from '@agent-workspace/gateway/tokens';

export interface RunTokenRun {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly status: RunStatus;
}

/**
 * The slice of the database a run-token check reads, generic over the workspace scope type so this
 * module names no persistence type. A `DatabaseRoot` satisfies it.
 */
export interface RunTokenDatabase<Scope = unknown> {
  readonly scopes: { forWorkspaceId(workspaceId: string): Promise<Scope | null> };
  readonly runTokens: {
    forScope(scope: Scope): {
      isActive(id: string, runId: string, tokenHash: string): Promise<boolean>;
    };
  };
  readonly runs: {
    forScope(scope: Scope): { get(runId: string): Promise<RunTokenRun | null> };
  };
}

export interface ActiveRunToken {
  readonly claims: RunTokenClaims;
  readonly run: RunTokenRun;
}

/**
 * A bearer that is a validly signed, unexpired, unrevoked run token registered for its own run,
 * whose run row agrees with the claims, or `null`. It does not look at the run's status: a runner
 * may still write transcripts after its run stops, so a caller that must refuse an ended run reads
 * `run.status` itself.
 */
export async function verifyActiveRunToken<Scope>(
  authorization: string | null,
  tokens: RunTokenCodec,
  database: RunTokenDatabase<Scope>,
): Promise<ActiveRunToken | null> {
  const presented = /^Bearer\s+([^\s]+)$/iu.exec(authorization ?? '')?.[1];
  if (presented === undefined) return null;
  const verified = await tokens.verify(presented);
  if (!verified.ok) return null;
  const claims = verified.claims;
  const scope = await database.scopes.forWorkspaceId(claims.workspaceId);
  if (scope === null) return null;
  const [active, run] = await Promise.all([
    database.runTokens
      .forScope(scope)
      .isActive(claims.tokenId, claims.runId, createHash('sha256').update(presented).digest('hex')),
    database.runs.forScope(scope).get(claims.runId),
  ]);
  if (
    active &&
    run !== null &&
    run.sessionId === claims.sessionId &&
    run.workspaceId === claims.workspaceId &&
    run.agentId === claims.agentId
  ) {
    return { claims, run };
  }
  return null;
}
