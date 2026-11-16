/**
 * Issue #2075, ADR-0161's 2026-11-01 amendment (DI10): the app's `app-backend` endpoint client
 * under `aw dev`. Its pair (`AW_APP_CLIENT_ID`, `AW_APP_CLIENT_SECRET`) is what the app's sign-in
 * hands `aw.auth.exchange`, so the app acts as the signed-in person.
 *
 * - One client, named after the app, binding the project's synced agents (1 to 64, ADR-0161 D4),
 *   with `oidcAudience` the app's client id at the issuer.
 * - Its secret is minted once per `aw dev` process and reaches only the app's environment: never a
 *   file, the terminal or a log. Each start writes one `oauth-client-secret-rotated` audit row.
 *
 * shortcut: the agents are bound when `aw dev` starts (after the first sync), not re-bound on a
 * later sync; upgrade when the sync grows an after-push hook.
 */
import { ENDPOINT_CLIENT_AGENTS_MAX } from '@indx-workspace/contracts/endpoint-clients';
import type { EndpointClientResource } from '@indx-workspace/contracts/endpoint-clients';
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

/** The pair the app exchanges ID tokens with (DI11's `AW_APP_CLIENT_ID` and `AW_APP_CLIENT_SECRET`). */
export interface AppBackendCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** The app's live `app-backend` client, or `undefined` when there is none. */
export async function findAppBackendClient(
  client: AgentWorkspaceClient,
  appName: string,
  signal: AbortSignal,
): Promise<EndpointClientResource | undefined> {
  return (await client.endpointClients.list({ signal })).find(
    (entry) => entry.kind === 'app-backend' && entry.name === appName && entry.revokedAt === null,
  );
}

/** Mint the client's secret for this process; the answer is never printed. */
export async function mintAppBackendSecret(
  client: AgentWorkspaceClient,
  id: string,
  signal: AbortSignal,
): Promise<AppBackendCredentials> {
  const minted = await client.endpointClients.rotateSecret(id, { signal });
  return { clientId: minted.clientId, clientSecret: minted.clientSecret };
}

/** Why `aw dev` made no `app-backend` client (DI10, DI11). */
export type AppBackendNotConfigured = 'no-agents' | 'too-many-agents' | 'no-audience';

/** The one notice line for {@link AppBackendNotConfigured}, with the reason. */
export function appBackendNotConfiguredNotice(
  appName: string,
  reason: AppBackendNotConfigured,
): string {
  const why = {
    'no-agents': 'the project has no synced agent yet',
    'too-many-agents': `the project has more than ${String(ENDPOINT_CLIENT_AGENTS_MAX)} agents`,
    'no-audience':
      'OIDC_* names your own identity provider and AW_OIDC_CLIENT_ID (the app’s client id there) is not set',
  }[reason];
  return `notice: app_backend_not_configured: the ${appName} app’s sign-in is not configured because ${why}.\n`;
}

/** What {@link ensureAppBackendClient} did. */
export type EnsuredAppBackend =
  | {
      readonly kind: 'created' | 'rebound' | 'unchanged';
      readonly client: EndpointClientResource;
    }
  | { readonly kind: 'not-configured'; readonly reason: AppBackendNotConfigured };

function sameAgents(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

/**
 * Make sure the app has its `app-backend` client binding `agentIds`: create it, re-bind it
 * (`PATCH`, which keeps its secret) when the set changed, or leave it. No agent, more than 64, or no
 * audience makes no client.
 */
export async function ensureAppBackendClient(
  client: AgentWorkspaceClient,
  options: {
    readonly appName: string;
    readonly oidcAudience: string | undefined;
    readonly agentIds: readonly string[];
    readonly existing: EndpointClientResource | undefined;
    readonly signal: AbortSignal;
  },
): Promise<EnsuredAppBackend> {
  const { appName, oidcAudience, agentIds, existing, signal } = options;
  if (oidcAudience === undefined) return { kind: 'not-configured', reason: 'no-audience' };
  if (agentIds.length === 0) return { kind: 'not-configured', reason: 'no-agents' };
  if (agentIds.length > ENDPOINT_CLIENT_AGENTS_MAX) {
    return { kind: 'not-configured', reason: 'too-many-agents' };
  }
  if (existing === undefined) {
    const created = await client.endpointClients.create(
      { name: appName, kind: 'app-backend', agentIds: [...agentIds], oidcAudience },
      { signal },
    );
    return { kind: 'created', client: created };
  }
  if (sameAgents(existing.agentIds, agentIds) && existing.oidcAudience === oidcAudience) {
    return { kind: 'unchanged', client: existing };
  }
  const rebound = await client.endpointClients.update(
    existing.id,
    { agentIds: [...agentIds], oidcAudience },
    { signal },
  );
  return { kind: 'rebound', client: rebound };
}

/** The ids of the project's agents in the workspace, by the names the project defines. */
export async function projectAgentIds(
  client: AgentWorkspaceClient,
  names: readonly string[],
  signal: AbortSignal,
): Promise<readonly string[]> {
  const wanted = new Set(names);
  return (await client.agents.list({ signal }))
    .filter((agent) => wanted.has(agent.name))
    .map((agent) => agent.id)
    .sort();
}
