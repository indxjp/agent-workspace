/**
 * `oauth_tokens` — the codes, access tokens and refresh tokens of the endpoint-client OAuth server
 * (ADR-0134 part 3). Like `browser_tokens`, only the SHA-256 digest of the secret half is stored.
 *
 * One authorization is one `family_id`: the code and every access/refresh token that descends from
 * it, so reuse of a code or of a rotated refresh token revokes them together. `subject_principal_id`
 * is the membership principal the token acts for; its role is read at verification time, never
 * snapshotted here.
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
import { endpointClients } from './endpoint-clients.js';
import { oneOf } from './one-of.js';
import { workspacePrincipals } from './workspace-principals.js';
import { workspaces } from './workspaces.js';

export const oauthTokenKinds = ['code', 'access', 'refresh'] as const;
export type OAuthTokenKind = (typeof oauthTokenKinds)[number];

export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id').notNull(),
    kind: text('kind', { enum: oauthTokenKinds }).notNull(),
    tokenHash: text('token_hash').notNull(),
    subjectPrincipalId: uuid('subject_principal_id').notNull(),
    /** The audience: the client's resource URL when the token was issued. */
    resource: text('resource').notNull(),
    familyId: uuid('family_id').notNull(),
    /** Set exactly when `kind = 'code'`. */
    codeChallenge: text('code_challenge'),
    /** Set exactly when `kind = 'code'`. */
    redirectUri: text('redirect_uri'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.clientId],
      foreignColumns: [endpointClients.workspaceId, endpointClients.id],
      name: 'oauth_tokens_client_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.subjectPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
      name: 'oauth_tokens_subject_workspace_fk',
    }).onDelete('cascade'),
    uniqueIndex('oauth_tokens_hash_key').on(table.tokenHash),
    index('oauth_tokens_workspace_family_idx').on(table.workspaceId, table.familyId),
    index('oauth_tokens_workspace_client_idx').on(
      table.workspaceId,
      table.clientId,
      table.revokedAt,
    ),
    oneOf('oauth_tokens_kind_valid', table.kind, oauthTokenKinds),
    check(
      'oauth_tokens_code_fields',
      sql`(${table.kind} = 'code') = (${table.codeChallenge} is not null and ${table.redirectUri} is not null)`,
    ),
    check('oauth_tokens_expiry_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export type OAuthToken = typeof oauthTokens.$inferSelect;
export type NewOAuthToken = typeof oauthTokens.$inferInsert;
