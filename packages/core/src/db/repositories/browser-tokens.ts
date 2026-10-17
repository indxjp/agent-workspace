import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { browserTokens, type BrowserTokenScopeKind } from '../schema/browser-tokens.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

interface IssueBrowserTokenInput {
  readonly id: string;
  readonly mintedByPrincipalId: string;
  readonly scope: { readonly kind: BrowserTokenScopeKind; readonly id: string };
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export interface ActiveBrowserToken {
  readonly id: string;
  readonly workspaceId: string;
  readonly mintedByPrincipalId: string;
  readonly scopeKind: BrowserTokenScopeKind;
  readonly runId: string | null;
  readonly sessionId: string | null;
  readonly expiresAt: Date;
}

export interface BrowserTokenRepository {
  issue(input: IssueBrowserTokenInput): Promise<void>;
  /** The active (unrevoked, unexpired) row for a hash, or `null`. Never trusts the caller's scope. */
  findActiveByHash(tokenHash: string, now?: Date): Promise<ActiveBrowserToken | null>;
  revokeForRun(runId: string, now?: Date): Promise<number>;
  /**
   * The session twin of {@link BrowserTokenRepository.revokeForRun}, which
   * `apps/web/server/composition/register.ts` calls when a run's credentials are revoked. This one
   * has no production caller yet: its site is session archival, and wiring it there is a later
   * unit's change. Until then an archived session's tokens keep `revoked_at IS NULL` until they
   * expire — they authenticate nobody, because the verifier refuses an archived session's token on
   * sight, but the row still reads as active.
   */
  revokeForSession(sessionId: string, now?: Date): Promise<number>;
}

export interface BrowserTokenRepositoryProvider {
  forScope(scope: WorkspaceScope): BrowserTokenRepository;
}

const ACTIVE_COLUMNS = {
  id: browserTokens.id,
  workspaceId: browserTokens.workspaceId,
  mintedByPrincipalId: browserTokens.mintedByPrincipalId,
  scopeKind: browserTokens.scopeKind,
  runId: browserTokens.runId,
  sessionId: browserTokens.sessionId,
  expiresAt: browserTokens.expiresAt,
} as const;

/**
 * Cross-tenant lookup by the globally-unique hash — the same shape `findRunWorkspace` (`./runs.js`)
 * uses, for the same reason: `browser_tokens_hash_key` names a token's workspace before any scope
 * is known, and the browser-token verifier is exactly the caller that does not know it yet. Reached
 * only through `./unscoped.js`, which is why it takes a raw `Database` rather than a scope.
 */
export async function findActiveBrowserTokenByHash(
  db: Database,
  tokenHash: string,
  now: Date = new Date(),
): Promise<ActiveBrowserToken | null> {
  const rows = await db
    .select(ACTIVE_COLUMNS)
    .from(browserTokens)
    .where(
      and(
        eq(browserTokens.tokenHash, tokenHash),
        isNull(browserTokens.revokedAt),
        gt(browserTokens.expiresAt, now),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Workspace-scoped registry used by the mint route and the browser-token verifier alike. */
export function createDatabaseBrowserTokenRepositoryProvider(
  db: Database,
): BrowserTokenRepositoryProvider {
  return {
    forScope(scope) {
      const checked = requireWorkspaceScope(scope, 'BrowserTokenRepositoryProvider');
      const owned = () => eq(browserTokens.workspaceId, checked.workspaceId);
      return {
        async issue(input) {
          await db.insert(browserTokens).values({
            id: input.id,
            workspaceId: checked.workspaceId,
            mintedByPrincipalId: input.mintedByPrincipalId,
            scopeKind: input.scope.kind,
            runId: input.scope.kind === 'run' ? input.scope.id : null,
            sessionId: input.scope.kind === 'session' ? input.scope.id : null,
            tokenHash: input.tokenHash,
            expiresAt: input.expiresAt,
          });
        },

        async findActiveByHash(tokenHash, now = new Date()) {
          const rows = await db
            .select(ACTIVE_COLUMNS)
            .from(browserTokens)
            .where(
              and(
                owned(),
                eq(browserTokens.tokenHash, tokenHash),
                isNull(browserTokens.revokedAt),
                gt(browserTokens.expiresAt, now),
              ),
            )
            .limit(1);
          return rows[0] ?? null;
        },

        async revokeForRun(runId, now = new Date()) {
          const changed = await db
            .update(browserTokens)
            .set({ revokedAt: sql`greatest(now(), ${now}::timestamptz)` })
            .where(and(owned(), eq(browserTokens.runId, runId), isNull(browserTokens.revokedAt)))
            .returning({ id: browserTokens.id });
          return changed.length;
        },

        async revokeForSession(sessionId, now = new Date()) {
          const changed = await db
            .update(browserTokens)
            .set({ revokedAt: sql`greatest(now(), ${now}::timestamptz)` })
            .where(
              and(owned(), eq(browserTokens.sessionId, sessionId), isNull(browserTokens.revokedAt)),
            )
            .returning({ id: browserTokens.id });
          return changed.length;
        },
      };
    },
  };
}
