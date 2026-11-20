import type { EndpointClientKind } from '../schema/endpoint-clients.js';
import { ENDPOINT_CLIENT_AGENTS_MAX } from '@indx-workspace/contracts/endpoint-clients';

const REDIRECT_URIS_MAX = 10;

/**
 * Dedupe and check the agent-count invariant: one for `a2a-agent`, 1-64 for `mcp-project` and
 * `app-backend`, none for `builder`.
 */
export function checkedAgentIds(kind: EndpointClientKind, agentIds: readonly string[]): string[] {
  const unique = [...new Set(agentIds)];
  const invalid =
    kind === 'builder'
      ? unique.length !== 0
      : kind === 'a2a-agent'
        ? unique.length !== 1
        : unique.length < 1;
  if (invalid) {
    throw new Error(`The ${kind} endpoint client has an invalid number of agents.`);
  }
  if (unique.length > ENDPOINT_CLIENT_AGENTS_MAX) {
    throw new Error(
      `An endpoint client lists at most ${String(ENDPOINT_CLIENT_AGENTS_MAX)} agents.`,
    );
  }
  return unique;
}

/** `endpoint_clients_oidc_audience_app_backend`, checked before the insert names the kind wrongly. */
export function checkedOidcAudience(
  kind: EndpointClientKind,
  oidcAudience: string | null | undefined,
): string | null {
  const audience = oidcAudience ?? null;
  if ((kind === 'app-backend') !== (audience !== null)) {
    throw new Error('oidcAudience is required for, and only for, an app-backend endpoint client.');
  }
  return audience;
}

export function checkedToolNames(
  kind: EndpointClientKind,
  toolNames: readonly string[] | null | undefined,
): string[] | null {
  if (toolNames === undefined || toolNames === null) return null;
  if (kind !== 'mcp-project') {
    throw new Error('toolNames applies to mcp-project endpoint clients only.');
  }
  return [...toolNames];
}

export function checkedRedirectUris(redirectUris: readonly string[]): string[] {
  if (redirectUris.length > REDIRECT_URIS_MAX) {
    throw new Error(`An endpoint client lists at most ${String(REDIRECT_URIS_MAX)} redirect URIs.`);
  }
  return [...new Set(redirectUris)];
}
