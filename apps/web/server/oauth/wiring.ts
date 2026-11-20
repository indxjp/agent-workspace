/**
 * The seam between the OAuth endpoints (ADR-0134 part 3) and the database layer. The composition
 * root builds it once and installs it as `ApplicationContext.oauth`; with no context installed the
 * OAuth endpoints answer their `server_error` 503.
 */
import type { Principal } from '../rbac/principal';
import type { OAuthClientRecord, OAuthTokenRows } from './store';

/** An endpoint client as the OAuth endpoints see it, with the resource its tokens are valid for. */
export interface OAuthClient extends OAuthClientRecord {
  /** Every agent the client is bound to; consent requires the member to be able to run all. */
  readonly agentIds: readonly string[];
  /** The protected resource's path, or `null` when it has none (an `a2a-agent` whose agent is gone). */
  readonly resourcePath: string | null;
  /** The label of the member who registered the client, shown on the consent page. */
  readonly creatorLabel?: string;
}

export interface OAuthAuditEvent {
  readonly action: 'oauth-grant-issued' | 'oauth-grant-revoked';
  readonly clientId: string;
  readonly clientName: string;
  readonly detail: string;
}

/** The person an ID token names, as a member of one workspace (ADR-0161 D5 step 7). */
export interface ExchangeMember {
  readonly userId: string;
  readonly principalId: string;
  /** The member's label at the time, for the audit row. */
  readonly label: string;
}

/** The access-token row an exchange writes (ADR-0161 D1): its own family, no refresh. */
export interface ExchangedToken {
  readonly id: string;
  readonly tokenHash: string;
  readonly familyId: string;
  readonly resource: string;
  readonly expiresAt: Date;
}

export interface OAuthRuntime {
  /** An unrevoked client by its `client_id`, in whichever workspace it lives. */
  findClient(clientId: string): Promise<OAuthClient | null>;
  /** Whether `principal` may run every one of `agentIds`, as `POST /api/agents/:id/runs` reads it. */
  canRunAll(principal: Principal, agentIds: readonly string[]): Promise<boolean>;
  /** The names of `agentIds` in that order for the consent page, or `null` if any no longer exists. */
  agentNames(workspaceId: string, agentIds: readonly string[]): Promise<readonly string[] | null>;
  tokens(workspaceId: string): Promise<OAuthTokenRows>;
  /** Audit as `actorPrincipalId`; the trail has no place for a secret and none is passed. */
  audit(workspaceId: string, actorPrincipalId: string, event: OAuthAuditEvent): Promise<void>;
  /**
   * The person `(issuer, subject)` names in `user_identities`, as an unrevoked member of
   * `workspaceId`; `null` for an unknown pair and for a person who is not a member there alike.
   * Nothing is written: there is no provisioning on exchange (ADR-0161 D5 step 7).
   */
  findMember(workspaceId: string, issuer: string, subject: string): Promise<ExchangeMember | null>;
  /**
   * Write an exchanged access token for `member` and its one `user-token-exchanged` audit row, in
   * one transaction (ADR-0161 D11).
   */
  issueExchanged(client: OAuthClient, member: ExchangeMember, token: ExchangedToken): Promise<void>;
}
