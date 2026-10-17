/**
 * The seam between the OAuth endpoints (ADR-0134 part 3) and the database layer, in the shape of
 * `endpoint-clients/runtime.ts`: a `globalThis` registry the composition root fills.
 */
import type { OAuthClientRecord, OAuthTokenRepository } from '@agent-workspace/core/db';

import type { Principal } from '../rbac/principal';

/** An endpoint client as the OAuth endpoints see it, with the resource its tokens are valid for. */
export interface OAuthClient extends OAuthClientRecord {
  /** Every agent the client is bound to; consent requires the member to be able to run all. */
  readonly agentIds: readonly string[];
  /** The protected resource's path, or `null` when it has none (an `a2a-agent` whose agent is gone). */
  readonly resourcePath: string | null;
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
  tokens(workspaceId: string): Promise<OAuthTokenRepository>;
  /** Audit as `actorPrincipalId`; the trail has no place for a secret and none is passed. */
  audit(workspaceId: string, actorPrincipalId: string, event: OAuthAuditEvent): Promise<void>;
}

interface Registry {
  __agentWorkspaceOAuthRuntime__?: OAuthRuntime;
}
const registry = globalThis as typeof globalThis & Registry;

export function configureOAuthRuntime(runtime: OAuthRuntime): void {
  registry.__agentWorkspaceOAuthRuntime__ = runtime;
}

export function clearOAuthRuntime(): void {
  delete registry.__agentWorkspaceOAuthRuntime__;
}

export function currentOAuthRuntime(): OAuthRuntime | null {
  return registry.__agentWorkspaceOAuthRuntime__ ?? null;
}
