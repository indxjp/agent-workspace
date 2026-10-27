/**
 * What the public MCP project endpoint (ADR-0134 part 2) needs from the rest of the control plane.
 * The composition root builds it once the run runtime is wired and installs it as
 * `ApplicationContext.toolEndpoint`; until then, and in a deployment with no runtime at all, the
 * endpoint answers `503 tool_endpoint_not_configured`. The client, its
 * audit trail and the agents' run permission stay the endpoint-clients runtime's; this seam adds only
 * who is calling, which code tools the client's agents publish and how to reach their sandbox.
 */
import type { AgentVersionToolBundle } from '@indx-workspace/contracts/agent-versions';

import type { RunOwnershipPrincipal } from '../agents/run-ownership';
import type { OAuthGrant } from '../rbac/principal';
import type { Ownership } from '../rbac/decide';
import type { RunPrincipal } from '../runs/environment';

export interface ToolEndpointIdentity {
  readonly principal: RunPrincipal;
  /** Only `api-key` and `oauth-token` are accepted. */
  readonly via: 'session' | 'api-key' | 'browser-token' | 'user-token' | 'oauth-token';
  /** `api_keys.id`, set exactly when `via` is `api-key`. It keys the rate limit; it is not a secret. */
  readonly apiKeyId: string | null;
  /** The client and audience of an OAuth access token, set exactly when `via` is `oauth-token`. */
  readonly oauth: OAuthGrant | null;
  /** The audit trail's name for the caller. */
  readonly label: string;
}

/** Where the gateway takes a call to the client's tool sandbox, and the 60-second grant for it. */
export interface ToolEndpointRoute {
  readonly url: string;
  readonly grant: string;
}

export interface ToolEndpointEnvironment {
  /** The caller, or `null` when the request carries no valid credential. */
  identify(request: Request): Promise<ToolEndpointIdentity | null>;
  /** Whether the key's member owns, or is granted, `agentId` (`agents/run-ownership.ts`). */
  agentOwnership(principal: RunOwnershipPrincipal, agentId: string): Promise<Ownership>;
  /** The code tools the `production`-pointed versions of `agentIds` pin, in the order of `agentIds`. */
  productionToolBundles(
    workspaceId: string,
    agentIds: readonly string[],
  ): Promise<readonly AgentVersionToolBundle[]>;
  /** Starts (or reuses) the client's tool sandbox for `bundles` and signs a grant for one call. */
  route(
    input: Readonly<{
      workspaceId: string;
      clientId: string;
      bundles: readonly AgentVersionToolBundle[];
    }>,
  ): Promise<ToolEndpointRoute>;
  /** Closes the client's tool sandbox; one that is not open is not an error. */
  closeSandbox(workspaceId: string, clientId: string): Promise<void>;
  readonly fetch: typeof fetch;
  now(): number;
}

/** The endpoint as the context holds it: `disabled` while no runtime can open a tool sandbox. */
export type ToolEndpoint =
  | { readonly kind: 'serving'; readonly environment: ToolEndpointEnvironment }
  | { readonly kind: 'disabled' };
