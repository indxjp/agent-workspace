/**
 * What the A2A endpoint (ADR-0135) needs from the rest of the control plane. The composition root
 * builds it once the run runtime is wired and installs it as `ApplicationContext.a2a`; until then,
 * and in a deployment with no runtime at all, the routes answer `503 a2a_not_configured`. Runs, sessions and their
 * authorisation stay the run API's; this seam adds only who is calling and which agent a public
 * name points at.
 */
import type { OAuthGrant } from '../rbac/principal';
import type { RunPrincipal } from '../runs/environment';

/** How the caller proved who it is; only `api-key` and `oauth-token` are accepted on the A2A routes. */
export type A2aCredentialVia =
  'session' | 'api-key' | 'browser-token' | 'user-token' | 'oauth-token';

export interface A2aIdentity {
  readonly principal: RunPrincipal;
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

/** The endpoint as the context holds it: `disabled` while no runtime can serve a run. */
export type A2a =
  | { readonly kind: 'serving'; readonly environment: A2aEnvironment }
  | { readonly kind: 'disabled' };
