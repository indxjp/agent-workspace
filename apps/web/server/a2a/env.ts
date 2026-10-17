/**
 * What the A2A endpoint (ADR-0135) needs from the rest of the control plane, installed by the
 * composition root the way `runs/environment.ts` installs the run API. Runs, sessions and their
 * authorisation stay the run API's; this seam adds only who is calling and which agent a public
 * name points at.
 */
import type { OAuthGrant } from '../rbac/principal';
import type { Principal } from '../runs/environment';

/** How the caller proved who it is; only `api-key` and `oauth-token` are accepted on the A2A routes. */
export type A2aCredentialVia =
  'session' | 'api-key' | 'browser-token' | 'user-token' | 'oauth-token';

export interface A2aIdentity {
  readonly principal: Principal;
  readonly via: A2aCredentialVia;
  /** `api_keys.id`, set exactly when `via` is `api-key`. It keys the rate limit; it is not a secret. */
  readonly apiKeyId: string | null;
  /** The client and audience of an OAuth access token, set exactly when `via` is `oauth-token`. */
  readonly oauth: OAuthGrant | null;
}

/** An agent with a `production` pointer: the only kind this endpoint serves. */
export interface PublishedAgent {
  readonly agentId: string;
  readonly name: string;
  readonly productionVersionId: string;
  readonly versionNumber: number;
}

export interface A2aEnvironment {
  /** The caller, or `null` when the request carries no valid credential. */
  identify(request: Request): Promise<A2aIdentity | null>;
  /** The agent named `name` in `workspaceId` that has a production pointer, else `null`. */
  findPublishedAgent(workspaceId: string, name: string): Promise<PublishedAgent | null>;
  /**
   * The published agent named `name` in the deployment's workspace (`WORKSPACE_SLUG`), else `null`.
   * It serves the agent card to a request with no credential, which names no workspace itself.
   */
  findDeploymentAgent(name: string): Promise<PublishedAgent | null>;
  now(): number;
}

interface A2aRegistry {
  __agentWorkspaceA2aEnvironment__?: A2aEnvironment;
}

// On `globalThis` for the reason `runs/environment.ts` gives: route bundles and instrumentation
// are separate module graphs in one process.
const registry = globalThis as typeof globalThis & A2aRegistry;

export function installA2a(environment: A2aEnvironment): void {
  registry.__agentWorkspaceA2aEnvironment__ = environment;
}

export function resetA2a(): void {
  delete registry.__agentWorkspaceA2aEnvironment__;
}

export function getA2a(): A2aEnvironment | null {
  return registry.__agentWorkspaceA2aEnvironment__ ?? null;
}
