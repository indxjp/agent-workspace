/**
 * `browser_tokens` — issue #236 (SDK-04, S-1): a short-lived, run- or session-scoped bearer a
 * customer's own backend mints for its own frontend.
 *
 * Modelled directly on `run-tokens.ts`'s precedent — a stored SHA-256 digest of the secret half,
 * never the bearer itself — with two additions `run_tokens` has no use for: the minting principal
 * (the scope grammar in `decide()` is enforced against the *minter's* current role, read at
 * verification time, never a role snapshotted onto this row — `apps/web/server/rbac/principal.ts`'s
 * header states why) and an XOR between exactly one of `run_id` / `session_id`, mirroring
 * `workspace_principals_source_xor`'s shape for the same reason: a scope has exactly one kind.
 */
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { createdAt, primaryKeyId } from './columns.js';
import { runs } from './runs.js';
import { sessions } from './sessions.js';
import { workspaces } from './workspaces.js';
import { workspacePrincipals } from './workspace-principals.js';

export const browserTokenScopeKinds = ['run', 'session'] as const;
export type BrowserTokenScopeKind = (typeof browserTokenScopeKinds)[number];

export const browserTokens = pgTable(
  'browser_tokens',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** `workspace_principals.id` of whoever minted this token (spec §3.1, the attenuation rule). */
    mintedByPrincipalId: uuid('minted_by_principal_id').notNull(),
    scopeKind: text('scope_kind', { enum: browserTokenScopeKinds }).notNull(),
    /** Set exactly when `scope_kind = 'run'`. */
    runId: uuid('run_id'),
    /** Set exactly when `scope_kind = 'session'`. */
    sessionId: uuid('session_id'),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.runId, table.workspaceId],
      foreignColumns: [runs.id, runs.workspaceId],
      name: 'browser_tokens_run_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.sessionId, table.workspaceId],
      foreignColumns: [sessions.id, sessions.workspaceId],
      name: 'browser_tokens_session_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.mintedByPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
      name: 'browser_tokens_minter_workspace_fk',
    }).onDelete('cascade'),
    uniqueIndex('browser_tokens_hash_key').on(table.tokenHash),
    index('browser_tokens_workspace_run_idx').on(table.workspaceId, table.runId),
    index('browser_tokens_workspace_session_idx').on(table.workspaceId, table.sessionId),
    index('browser_tokens_active_idx').on(table.workspaceId, table.revokedAt, table.expiresAt),
    check('browser_tokens_scope_kind_valid', sql`${table.scopeKind} in ('run', 'session')`),
    // One scope, one kind: exactly the `workspace_principals_source_xor` shape, applied to a run
    // id and a session id instead of a membership id and an API-key id.
    check(
      'browser_tokens_scope_xor',
      sql`(${table.scopeKind} = 'run' and ${table.runId} is not null and ${table.sessionId} is null)
        or (${table.scopeKind} = 'session' and ${table.sessionId} is not null and ${table.runId} is null)`,
    ),
    check('browser_tokens_expiry_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'browser_tokens_revoked_after_created',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
);

export type BrowserToken = typeof browserTokens.$inferSelect;
export type NewBrowserToken = typeof browserTokens.$inferInsert;
