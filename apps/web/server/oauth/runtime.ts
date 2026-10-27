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
}
