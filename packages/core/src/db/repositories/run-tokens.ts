import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { runTokens } from '../schema/run-tokens.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

interface RegisterRunTokenInput {
  readonly id: string;
  readonly runId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

type RevokeRunTokenOutcome = 'revoked' | 'already-revoked' | 'not-found';

export interface RunTokenRepository {
  register(input: RegisterRunTokenInput): Promise<void>;
  isActive(id: string, runId: string, tokenHash: string, now?: Date): Promise<boolean>;
  revoke(id: string, runId: string, now?: Date): Promise<RevokeRunTokenOutcome>;
  revokeForRun(runId: string, now?: Date): Promise<number>;
}

export interface RunTokenRepositoryProvider {
  forScope(scope: WorkspaceScope): RunTokenRepository;
}

/** Workspace-scoped registry used by both the issuer and the gateway verifier. */
export function createDatabaseRunTokenRepositoryProvider(db: Database): RunTokenRepositoryProvider {
  return {
    forScope(scope) {
      const checked = requireWorkspaceScope(scope, 'RunTokenRepositoryProvider');
      const owned = (runId: string) =>
        and(eq(runTokens.workspaceId, checked.workspaceId), eq(runTokens.runId, runId));
      return {
        async register(input) {
          await db.insert(runTokens).values({
            id: input.id,
            runId: input.runId,
            workspaceId: checked.workspaceId,
            tokenHash: input.tokenHash,
            expiresAt: input.expiresAt,
          });
        },

        async isActive(id, runId, tokenHash, now = new Date()) {
          const rows = await db
            .select({ id: runTokens.id })
            .from(runTokens)
            .where(
              and(
                owned(runId),
                eq(runTokens.id, id),
                eq(runTokens.tokenHash, tokenHash),
                isNull(runTokens.revokedAt),
                gt(runTokens.expiresAt, now),
              ),
            )
            .limit(1);
          return rows.length > 0;
        },

        async revoke(id, runId, now = new Date()) {
          const changed = await db
            .update(runTokens)
            .set({ revokedAt: sql`greatest(now(), ${now}::timestamptz)` })
            .where(and(owned(runId), eq(runTokens.id, id), isNull(runTokens.revokedAt)))
            .returning({ id: runTokens.id });
          if (changed.length > 0) return 'revoked';
          const existing = await db
            .select({ revokedAt: runTokens.revokedAt })
            .from(runTokens)
            .where(and(owned(runId), eq(runTokens.id, id)))
            .limit(1);
          return existing.length === 0 ? 'not-found' : 'already-revoked';
        },

        async revokeForRun(runId, now = new Date()) {
          const changed = await db
            .update(runTokens)
            .set({ revokedAt: sql`greatest(now(), ${now}::timestamptz)` })
            .where(and(owned(runId), isNull(runTokens.revokedAt)))
            .returning({ id: runTokens.id });
          return changed.length;
        },
      };
    },
  };
}
