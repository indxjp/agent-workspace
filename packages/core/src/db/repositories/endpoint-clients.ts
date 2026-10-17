import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ENDPOINT_CLIENT_AGENTS_MAX } from '@indx-workspace/contracts/endpoint-clients';

import type { Database } from '../client.js';
import { apiKeys } from '../schema/api-keys.js';
import { endpointClientAgents } from '../schema/endpoint-client-agents.js';
import { endpointClientApiKeys } from '../schema/endpoint-client-api-keys.js';
import {
  endpointClients,
  type EndpointClient,
  type EndpointClientKind,
} from '../schema/endpoint-clients.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';
import { postgresViolations } from './violations.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

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
  readonly actsForPrincipalId: string;
  readonly createdByPrincipalId: string;
  /** Every key bound to the client, revoked ones included. Ids only; never a secret. */
  readonly apiKeyIds: readonly string[];
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewEndpointClientInput {
  readonly name: string;
  readonly kind: EndpointClientKind;
  readonly agentIds: readonly string[];
  readonly toolNames?: readonly string[] | null;
  readonly actsForPrincipalId: string;
  readonly createdByPrincipalId: string;
}

export interface EndpointClientPatch {
  readonly agentIds?: readonly string[] | undefined;
  readonly toolNames?: readonly string[] | null | undefined;
  readonly redirectUris?: readonly string[] | undefined;
}

export interface EndpointClientRepository {
  list(): Promise<readonly EndpointClientRecord[]>;
  get(id: string): Promise<EndpointClientRecord | null>;
  findByName(kind: EndpointClientKind, name: string): Promise<EndpointClientRecord | null>;
  /**
   * Insert the client and its agent rows in one transaction. A foreign workspace's agent id is
   * refused by the tenant-paired foreign key (the call throws and nothing is written).
   */
  create(
    input: NewEndpointClientInput,
  ): Promise<{ kind: 'created'; client: EndpointClientRecord } | { kind: 'name-taken' }>;
  /**
   * Replace the agents and/or the tool allow-list. A client revoked before the row lock is taken is
   * `revoked` and left as it is.
   */
  update(
    id: string,
    patch: EndpointClientPatch,
  ): Promise<
    { kind: 'updated'; client: EndpointClientRecord } | { kind: 'not-found' } | { kind: 'revoked' }
  >;
  /**
   * Store the hash of a new OAuth client secret, replacing the old one. `revoked` for a revoked
   * client, `not-found` when absent.
   */
  setSecretHash(
    id: string,
    secretHash: string,
    at: Date,
  ): Promise<
    { kind: 'set'; client: EndpointClientRecord } | { kind: 'not-found' } | { kind: 'revoked' }
  >;
  /**
   * Set `revoked_at` on the client and revoke every key bound to it (and the key principals), in
   * one transaction. Idempotent: a revoked client is returned as it is, with no `revokedKeys`.
   * `null` when absent.
   */
  revoke(id: string, at: Date): Promise<EndpointClientRevocation | null>;
}

interface EndpointClientRevocation {
  readonly client: EndpointClientRecord;
  /** The keys this call revoked. Ids and names only; never a secret. */
  readonly revokedKeys: readonly { readonly id: string; readonly name: string }[];
}

export interface EndpointClientRepositoryProvider {
  forScope(scope: WorkspaceScope): EndpointClientRepository;
}

const REDIRECT_URIS_MAX = 10;

/** Dedupe and check the agent-count invariant: one for `a2a-agent`, 1-64 for `mcp-project`. */
function checkedAgentIds(kind: EndpointClientKind, agentIds: readonly string[]): string[] {
  const unique = [...new Set(agentIds)];
  if (kind === 'a2a-agent' ? unique.length !== 1 : unique.length < 1) {
    throw new Error(`An ${kind} endpoint client has an invalid number of agents.`);
  }
  if (unique.length > ENDPOINT_CLIENT_AGENTS_MAX) {
    throw new Error(
      `An endpoint client lists at most ${String(ENDPOINT_CLIENT_AGENTS_MAX)} agents.`,
    );
  }
  return unique;
}

function checkedToolNames(
  kind: EndpointClientKind,
  toolNames: readonly string[] | null | undefined,
): string[] | null {
  if (toolNames === undefined || toolNames === null) return null;
  if (kind !== 'mcp-project') {
    throw new Error('toolNames applies to mcp-project endpoint clients only.');
  }
  return [...toolNames];
}

async function hydrate(
  executor: Database | Transaction,
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
    actsForPrincipalId: row.actsForPrincipalId,
    createdByPrincipalId: row.createdByPrincipalId,
    apiKeyIds: keyRows.filter((key) => key.clientId === row.id).map((key) => key.apiKeyId),
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export function createDatabaseEndpointClientRepositoryProvider(
  db: Database,
): EndpointClientRepositoryProvider {
  return {
    forScope(scope) {
      const { workspaceId } = requireWorkspaceScope(scope, 'EndpointClientRepositoryProvider');

      const readOne = async (
        executor: Database | Transaction,
        id: string,
      ): Promise<EndpointClientRecord | null> => {
        const rows = await executor
          .select()
          .from(endpointClients)
          .where(and(eq(endpointClients.workspaceId, workspaceId), eq(endpointClients.id, id)))
          .limit(1);
        return (await hydrate(executor, workspaceId, rows))[0] ?? null;
      };

      return {
        async list() {
          const rows = await db
            .select()
            .from(endpointClients)
            .where(eq(endpointClients.workspaceId, workspaceId))
            .orderBy(asc(endpointClients.name), asc(endpointClients.kind));
          return hydrate(db, workspaceId, rows);
        },
        get: (id) => readOne(db, id),
        async findByName(kind, name) {
          const rows = await db
            .select()
            .from(endpointClients)
            .where(
              and(
                eq(endpointClients.workspaceId, workspaceId),
                eq(endpointClients.kind, kind),
                eq(endpointClients.name, name),
              ),
            )
            .limit(1);
          return (await hydrate(db, workspaceId, rows))[0] ?? null;
        },
        async create(input) {
          const agentIds = checkedAgentIds(input.kind, input.agentIds);
          const toolNames = checkedToolNames(input.kind, input.toolNames);
          try {
            return await db.transaction(async (tx) => {
              const inserted = await tx
                .insert(endpointClients)
                .values({
                  workspaceId,
                  name: input.name,
                  kind: input.kind,
                  toolNames,
                  actsForPrincipalId: input.actsForPrincipalId,
                  createdByPrincipalId: input.createdByPrincipalId,
                })
                .returning();
              const row = inserted[0];
              if (row === undefined) throw new Error('endpoint client insert returned no row');
              await tx
                .insert(endpointClientAgents)
                .values(agentIds.map((agentId) => ({ clientId: row.id, workspaceId, agentId })));
              const client = await readOne(tx, row.id);
              if (client === null)
                throw new Error('endpoint client vanished inside its transaction');
              return { kind: 'created' as const, client };
            });
          } catch (error) {
            for (const violation of postgresViolations(error)) {
              if (violation.constraint === 'endpoint_clients_workspace_kind_name_key') {
                return { kind: 'name-taken' as const };
              }
            }
            throw error;
          }
        },
        async update(id, patch) {
          return db.transaction(async (tx) => {
            const locked = await tx
              .select()
              .from(endpointClients)
              .where(and(eq(endpointClients.workspaceId, workspaceId), eq(endpointClients.id, id)))
              .for('update');
            const current = locked[0];
            if (current === undefined) return { kind: 'not-found' as const };
            if (current.revokedAt !== null) return { kind: 'revoked' as const };
            const agentIds =
              patch.agentIds === undefined ? null : checkedAgentIds(current.kind, patch.agentIds);
            const toolNames =
              patch.toolNames === undefined
                ? undefined
                : checkedToolNames(current.kind, patch.toolNames);
            if (patch.redirectUris !== undefined && patch.redirectUris.length > REDIRECT_URIS_MAX) {
              throw new Error(
                `An endpoint client lists at most ${String(REDIRECT_URIS_MAX)} redirect URIs.`,
              );
            }
            if (agentIds !== null) {
              await tx
                .delete(endpointClientAgents)
                .where(
                  and(
                    eq(endpointClientAgents.workspaceId, workspaceId),
                    eq(endpointClientAgents.clientId, id),
                  ),
                );
              await tx
                .insert(endpointClientAgents)
                .values(agentIds.map((agentId) => ({ clientId: id, workspaceId, agentId })));
            }
            await tx
              .update(endpointClients)
              .set({
                updatedAt: sql`now()`,
                ...(toolNames === undefined ? {} : { toolNames }),
                ...(patch.redirectUris === undefined
                  ? {}
                  : { redirectUris: [...new Set(patch.redirectUris)] }),
              })
              .where(and(eq(endpointClients.workspaceId, workspaceId), eq(endpointClients.id, id)));
            const client = await readOne(tx, id);
            if (client === null) throw new Error('endpoint client vanished inside its transaction');
            return { kind: 'updated' as const, client };
          });
        },
        async setSecretHash(id, secretHash, at) {
          return db.transaction(async (tx) => {
            const locked = await tx
              .select({ revokedAt: endpointClients.revokedAt })
              .from(endpointClients)
              .where(and(eq(endpointClients.workspaceId, workspaceId), eq(endpointClients.id, id)))
              .for('update');
            const current = locked[0];
            if (current === undefined) return { kind: 'not-found' as const };
            if (current.revokedAt !== null) return { kind: 'revoked' as const };
            await tx
              .update(endpointClients)
              .set({
                clientSecretHash: secretHash,
                clientSecretRotatedAt: sql`greatest(now(), ${at}::timestamptz)`,
              })
              .where(and(eq(endpointClients.workspaceId, workspaceId), eq(endpointClients.id, id)));
            const client = await readOne(tx, id);
            if (client === null) throw new Error('endpoint client vanished inside its transaction');
            return { kind: 'set' as const, client };
          });
        },
        async revoke(id, at) {
          return db.transaction(async (tx) => {
            const locked = await tx
              .select()
              .from(endpointClients)
              .where(and(eq(endpointClients.workspaceId, workspaceId), eq(endpointClients.id, id)))
              .for('update');
            const current = locked[0];
            if (current === undefined) return null;
            const revocation = async (
              revokedKeys: EndpointClientRevocation['revokedKeys'],
            ): Promise<EndpointClientRevocation> => {
              const client = await readOne(tx, id);
              if (client === null) {
                throw new Error('endpoint client vanished inside its transaction');
              }
              return { client, revokedKeys };
            };
            if (current.revokedAt !== null) return revocation([]);
            const updated = await tx
              .update(endpointClients)
              .set({ revokedAt: sql`greatest(now(), ${at}::timestamptz)` })
              .where(and(eq(endpointClients.workspaceId, workspaceId), eq(endpointClients.id, id)))
              .returning({ revokedAt: endpointClients.revokedAt });
            const revokedAt = updated[0]?.revokedAt;
            if (revokedAt === undefined || revokedAt === null) {
              throw new Error('endpoint client revocation returned no timestamp');
            }
            const bound = tx
              .select({ id: endpointClientApiKeys.apiKeyId })
              .from(endpointClientApiKeys)
              .where(
                and(
                  eq(endpointClientApiKeys.workspaceId, workspaceId),
                  eq(endpointClientApiKeys.clientId, id),
                ),
              );
            const revokedKeys = await tx
              .update(apiKeys)
              .set({ revokedAt })
              .where(
                and(
                  eq(apiKeys.workspaceId, workspaceId),
                  inArray(apiKeys.id, bound),
                  isNull(apiKeys.revokedAt),
                ),
              )
              .returning({ id: apiKeys.id, name: apiKeys.name });
            if (revokedKeys.length > 0) {
              await tx
                .update(workspacePrincipals)
                .set({ revokedAt })
                .where(
                  and(
                    eq(workspacePrincipals.workspaceId, workspaceId),
                    inArray(
                      workspacePrincipals.apiKeyId,
                      revokedKeys.map((key) => key.id),
                    ),
                    isNull(workspacePrincipals.revokedAt),
                  ),
                );
            }
            return revocation(revokedKeys);
          });
        },
      };
    },
  };
}
