import { and, asc, eq, inArray } from 'drizzle-orm';

import type { Database } from '../client.js';
import { endpointClientAgents } from '../schema/endpoint-client-agents.js';
import { endpointClientApiKeys } from '../schema/endpoint-client-api-keys.js';
import type { EndpointClient, EndpointClientKind } from '../schema/endpoint-clients.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type EndpointClientExecutor = Database | Transaction;

export interface EndpointClientRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly kind: EndpointClientKind;
  readonly agentIds: readonly string[];
  readonly toolNames: readonly string[] | null;
  /** OAuth redirect URIs (ADR-0134 part 3), exact strings. */
  readonly redirectUris: readonly string[];
  /** Whether a confidential OAuth secret is set. The hash itself never leaves the repository. */
  readonly hasClientSecret: boolean;
  /** The ID token audience of an `app-backend` client (ADR-0161 D4); `null` for every other kind. */
  readonly oidcAudience: string | null;
  readonly actsForPrincipalId: string;
  readonly createdByPrincipalId: string;
  /** Every key bound to the client, revoked ones included. Ids only; never a secret. */
  readonly apiKeyIds: readonly string[];
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export async function hydrate(
  executor: EndpointClientExecutor,
  workspaceId: string,
  rows: readonly EndpointClient[],
): Promise<EndpointClientRecord[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const agentRows = await executor
    .select({ clientId: endpointClientAgents.clientId, agentId: endpointClientAgents.agentId })
    .from(endpointClientAgents)
    .where(
      and(
        eq(endpointClientAgents.workspaceId, workspaceId),
        inArray(endpointClientAgents.clientId, ids),
      ),
    )
    .orderBy(asc(endpointClientAgents.agentId));
  const keyRows = await executor
    .select({
      clientId: endpointClientApiKeys.clientId,
      apiKeyId: endpointClientApiKeys.apiKeyId,
    })
    .from(endpointClientApiKeys)
    .where(
      and(
        eq(endpointClientApiKeys.workspaceId, workspaceId),
        inArray(endpointClientApiKeys.clientId, ids),
      ),
    )
    .orderBy(asc(endpointClientApiKeys.apiKeyId));
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    kind: row.kind,
    agentIds: agentRows.filter((agent) => agent.clientId === row.id).map((agent) => agent.agentId),
    toolNames: row.toolNames,
    redirectUris: row.redirectUris,
    hasClientSecret: row.clientSecretHash !== null,
    oidcAudience: row.oidcAudience,
    actsForPrincipalId: row.actsForPrincipalId,
    createdByPrincipalId: row.createdByPrincipalId,
    apiKeyIds: keyRows.filter((key) => key.clientId === row.id).map((key) => key.apiKeyId),
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}
