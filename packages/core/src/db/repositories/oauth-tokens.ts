import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { endpointClientAgents } from '../schema/endpoint-client-agents.js';
import { endpointClients, type EndpointClientKind } from '../schema/endpoint-clients.js';
import { oauthTokens, type OAuthTokenKind } from '../schema/oauth-tokens.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

export interface IssueOAuthTokenInput {
  readonly id: string;
  readonly clientId: string;
  readonly kind: OAuthTokenKind;
  readonly tokenHash: string;
  readonly subjectPrincipalId: string;
  readonly resource: string;
  readonly familyId: string;
  /** Required for, and only for, `kind: 'code'`. */
  readonly codeChallenge?: string | undefined;
  readonly redirectUri?: string | undefined;
  readonly expiresAt: Date;
}

export interface OAuthTokenRecord {
  readonly id: string;
  readonly clientId: string;
  readonly kind: OAuthTokenKind;
  readonly subjectPrincipalId: string;
  readonly resource: string;
  readonly familyId: string;
  readonly codeChallenge: string | null;
  readonly redirectUri: string | null;
}

/** What presenting a single-use token (a code or a refresh token) comes to. */
export type OAuthConsumeOutcome =
  | { readonly kind: 'consumed'; readonly token: OAuthTokenRecord }
  /** The token was already spent: its family is the thief's, and the caller revokes it. */
  | {
      readonly kind: 'reused';
      readonly familyId: string;
      /** Who the grant was issued to; the audit trail names them as the actor. */
      readonly subjectPrincipalId: string;
    }
  | { readonly kind: 'invalid' };

export interface OAuthTokenRepository {
  issue(input: IssueOAuthTokenInput): Promise<void>;
  /**
   * Spend a code or refresh token for `clientId`. The `UPDATE ... WHERE used_at IS NULL` is the
   * single-use guarantee: of two concurrent presentations exactly one is `consumed`.
   */
  consume(
    kind: 'code' | 'refresh',
    tokenHash: string,
    clientId: string,
    now?: Date,
  ): Promise<OAuthConsumeOutcome>;
  /** Revoke every live token of one authorization. Returns how many rows it changed. */
  revokeFamily(familyId: string, now?: Date): Promise<number>;
  /**
   * RFC 7009: revoke the access or refresh token `tokenHash` belongs to for `clientId`. A refresh
   * token revokes its whole family. `null` when no such token exists or it is already revoked, so a
   * repeated revocation is not reported (or audited) twice.
   */
  revoke(
    tokenHash: string,
    clientId: string,
    now?: Date,
  ): Promise<{
    readonly kind: OAuthTokenKind;
    readonly familyId: string;
    readonly subjectPrincipalId: string;
  } | null>;
}

export interface OAuthTokenRepositoryProvider {
  forScope(scope: WorkspaceScope): OAuthTokenRepository;
}

/** An access token resolved to the endpoint client it was issued for. */
export interface ActiveOAuthAccessToken {
  readonly workspaceId: string;
  readonly clientId: string;
  readonly clientKind: EndpointClientKind;
  readonly clientName: string;
  /** The agent of an `a2a-agent` client; `null` for `mcp-project`. */
  readonly agentId: string | null;
  readonly subjectPrincipalId: string;
  readonly resource: string;
}

/** An endpoint client as the token endpoint authenticates it. */
export interface OAuthClientRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly kind: EndpointClientKind;
  readonly actsForPrincipalId: string;
  readonly clientSecretHash: string | null;
  readonly redirectUris: readonly string[];
}

const RECORD_COLUMNS = {
  id: oauthTokens.id,
  clientId: oauthTokens.clientId,
  kind: oauthTokens.kind,
  subjectPrincipalId: oauthTokens.subjectPrincipalId,
  resource: oauthTokens.resource,
  familyId: oauthTokens.familyId,
  codeChallenge: oauthTokens.codeChallenge,
  redirectUri: oauthTokens.redirectUri,
} as const;

/**
 * Cross-tenant lookup of an unrevoked endpoint client by its id, which is the OAuth `client_id`:
 * the token endpoint knows nothing else about the caller. The same declared exception as
 * `findActiveOAuthAccessToken`; reached only through `./unscoped.js`.
 */
export async function findOAuthClient(
  db: Database,
  clientId: string,
): Promise<OAuthClientRecord | null> {
  const rows = await db
    .select({
      id: endpointClients.id,
      workspaceId: endpointClients.workspaceId,
      name: endpointClients.name,
      kind: endpointClients.kind,
      actsForPrincipalId: endpointClients.actsForPrincipalId,
      clientSecretHash: endpointClients.clientSecretHash,
      redirectUris: endpointClients.redirectUris,
    })
    .from(endpointClients)
    .where(and(eq(endpointClients.id, clientId), isNull(endpointClients.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Cross-tenant lookup of a live access token by its globally unique hash, before the caller knows
 * which workspace it names (the same exception as `findActiveBrowserTokenByHash`). A revoked client
 * kills every token it issued here, and an `a2a-agent` client whose agent is gone fails closed.
 */
export async function findActiveOAuthAccessToken(
  db: Database,
  tokenHash: string,
  now: Date = new Date(),
): Promise<ActiveOAuthAccessToken | null> {
  const rows = await db
    .select({
      workspaceId: oauthTokens.workspaceId,
      clientId: oauthTokens.clientId,
      clientKind: endpointClients.kind,
      clientName: endpointClients.name,
      agentId: endpointClientAgents.agentId,
      subjectPrincipalId: oauthTokens.subjectPrincipalId,
      resource: oauthTokens.resource,
    })
    .from(oauthTokens)
    .innerJoin(
      endpointClients,
      and(
        eq(endpointClients.workspaceId, oauthTokens.workspaceId),
        eq(endpointClients.id, oauthTokens.clientId),
      ),
    )
    .leftJoin(
      endpointClientAgents,
      and(
        eq(endpointClientAgents.workspaceId, endpointClients.workspaceId),
        eq(endpointClientAgents.clientId, endpointClients.id),
      ),
    )
    .where(
      and(
        eq(oauthTokens.tokenHash, tokenHash),
        eq(oauthTokens.kind, 'access'),
        isNull(oauthTokens.revokedAt),
        gt(oauthTokens.expiresAt, now),
        isNull(endpointClients.revokedAt),
      ),
    )
    .orderBy(asc(endpointClientAgents.agentId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  if (row.clientKind === 'a2a-agent' && row.agentId === null) return null;
  return { ...row, agentId: row.clientKind === 'a2a-agent' ? row.agentId : null };
}

export function createDatabaseOAuthTokenRepositoryProvider(
  db: Database,
): OAuthTokenRepositoryProvider {
  return {
    forScope(scope) {
      const { workspaceId } = requireWorkspaceScope(scope, 'OAuthTokenRepositoryProvider');
      const owned = () => eq(oauthTokens.workspaceId, workspaceId);
      const revokeFamily = async (familyId: string, now: Date): Promise<number> => {
        const changed = await db
          .update(oauthTokens)
          .set({ revokedAt: sql`greatest(now(), ${now}::timestamptz)` })
          .where(and(owned(), eq(oauthTokens.familyId, familyId), isNull(oauthTokens.revokedAt)))
          .returning({ id: oauthTokens.id });
        return changed.length;
      };
      return {
        async issue(input) {
          await db.insert(oauthTokens).values({
            id: input.id,
            workspaceId,
            clientId: input.clientId,
            kind: input.kind,
            tokenHash: input.tokenHash,
            subjectPrincipalId: input.subjectPrincipalId,
            resource: input.resource,
            familyId: input.familyId,
            codeChallenge: input.codeChallenge ?? null,
            redirectUri: input.redirectUri ?? null,
            expiresAt: input.expiresAt,
          });
        },

        async consume(kind, tokenHash, clientId, now = new Date()) {
          const matches = and(
            owned(),
            eq(oauthTokens.kind, kind),
            eq(oauthTokens.tokenHash, tokenHash),
            eq(oauthTokens.clientId, clientId),
          );
          const consumed = await db
            .update(oauthTokens)
            .set({ usedAt: sql`greatest(now(), ${now}::timestamptz)` })
            .where(
              and(
                matches,
                isNull(oauthTokens.usedAt),
                isNull(oauthTokens.revokedAt),
                gt(oauthTokens.expiresAt, now),
              ),
            )
            .returning(RECORD_COLUMNS);
          const token = consumed[0];
          if (token !== undefined) return { kind: 'consumed', token };
          const spent = await db
            .select({
              familyId: oauthTokens.familyId,
              subjectPrincipalId: oauthTokens.subjectPrincipalId,
            })
            .from(oauthTokens)
            .where(and(matches, sql`${oauthTokens.usedAt} is not null`))
            .limit(1);
          const row = spent[0];
          return row === undefined
            ? { kind: 'invalid' }
            : {
                kind: 'reused',
                familyId: row.familyId,
                subjectPrincipalId: row.subjectPrincipalId,
              };
        },

        revokeFamily: (familyId, now = new Date()) => revokeFamily(familyId, now),

        async revoke(tokenHash, clientId, now = new Date()) {
          // One statement: of two concurrent revocations only the one whose UPDATE changed the row
          // gets it back, so only that caller is reported and audited.
          const rows = await db
            .update(oauthTokens)
            .set({ revokedAt: sql`greatest(now(), ${now}::timestamptz)` })
            .where(
              and(
                owned(),
                eq(oauthTokens.tokenHash, tokenHash),
                eq(oauthTokens.clientId, clientId),
                sql`${oauthTokens.kind} in ('access', 'refresh')`,
                isNull(oauthTokens.revokedAt),
              ),
            )
            .returning({
              kind: oauthTokens.kind,
              familyId: oauthTokens.familyId,
              subjectPrincipalId: oauthTokens.subjectPrincipalId,
            });
          const found = rows[0];
          if (found === undefined) return null;
          if (found.kind === 'refresh') await revokeFamily(found.familyId, now);
          return found;
        },
      };
    },
  };
}
