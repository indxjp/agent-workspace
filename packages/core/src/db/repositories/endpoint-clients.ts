import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { apiKeys } from '../schema/api-keys.js';
import { endpointClientAgents } from '../schema/endpoint-client-agents.js';
import { endpointClientApiKeys } from '../schema/endpoint-client-api-keys.js';
import { endpointClients, type EndpointClientKind } from '../schema/endpoint-clients.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import {
  hydrate,
  type EndpointClientExecutor,
  type EndpointClientRecord,
} from './endpoint-client-records.js';
import {
  checkedAgentIds,
  checkedOidcAudience,
  checkedRedirectUris,
  checkedToolNames,
} from './endpoint-client-validation.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';
import { postgresViolations } from './violations.js';

export type { EndpointClientRecord } from './endpoint-client-records.js';

export interface NewEndpointClientInput {
  readonly name: string;
  readonly kind: EndpointClientKind;
  readonly agentIds: readonly string[];
  readonly toolNames?: readonly string[] | null;
  /** Required for, and only for, an `app-backend` client. */
  readonly oidcAudience?: string | null;
  readonly actsForPrincipalId: string;
  readonly createdByPrincipalId: string;
}

export interface EndpointClientPatch {
  readonly agentIds?: readonly string[] | undefined;
  readonly toolNames?: readonly string[] | null | undefined;
  readonly redirectUris?: readonly string[] | undefined;
  /** An `app-backend` client's ID token audience; refused for every other kind. */
  readonly oidcAudience?: string | undefined;
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

interface ClientContext {
  readonly db: Database;
  readonly workspaceId: string;
}

const VANISHED = 'endpoint client vanished inside its transaction';

function clientWhere(ctx: ClientContext, id: string) {
  return and(eq(endpointClients.workspaceId, ctx.workspaceId), eq(endpointClients.id, id));
}

async function readOne(
  executor: EndpointClientExecutor,
  ctx: ClientContext,
  id: string,
): Promise<EndpointClientRecord | null> {
  const rows = await executor.select().from(endpointClients).where(clientWhere(ctx, id)).limit(1);
  return (await hydrate(executor, ctx.workspaceId, rows))[0] ?? null;
}

async function readRequired(
  executor: EndpointClientExecutor,
  ctx: ClientContext,
  id: string,
): Promise<EndpointClientRecord> {
  const client = await readOne(executor, ctx, id);
  if (client === null) throw new Error(VANISHED);
  return client;
}

async function listClients(ctx: ClientContext): Promise<EndpointClientRecord[]> {
  const rows = await ctx.db
    .select()
    .from(endpointClients)
    .where(eq(endpointClients.workspaceId, ctx.workspaceId))
    .orderBy(asc(endpointClients.name), asc(endpointClients.kind));
  return hydrate(ctx.db, ctx.workspaceId, rows);
}

async function findClientByName(
  ctx: ClientContext,
  kind: EndpointClientKind,
  name: string,
): Promise<EndpointClientRecord | null> {
  const rows = await ctx.db
    .select()
    .from(endpointClients)
    .where(
      and(
        eq(endpointClients.workspaceId, ctx.workspaceId),
        eq(endpointClients.kind, kind),
        eq(endpointClients.name, name),
      ),
    )
    .limit(1);
  return (await hydrate(ctx.db, ctx.workspaceId, rows))[0] ?? null;
}

async function createClient(
  ctx: ClientContext,
  input: NewEndpointClientInput,
): ReturnType<EndpointClientRepository['create']> {
  const { db, workspaceId } = ctx;
  const agentIds = checkedAgentIds(input.kind, input.agentIds);
  const toolNames = checkedToolNames(input.kind, input.toolNames);
  const oidcAudience = checkedOidcAudience(input.kind, input.oidcAudience);
  try {
    return await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(endpointClients)
        .values({
          workspaceId,
          name: input.name,
          kind: input.kind,
          toolNames,
          oidcAudience,
          actsForPrincipalId: input.actsForPrincipalId,
          createdByPrincipalId: input.createdByPrincipalId,
        })
        .returning();
      const row = inserted[0];
      if (row === undefined) throw new Error('endpoint client insert returned no row');
      await insertAgents(tx, ctx, row.id, agentIds);
      return { kind: 'created' as const, client: await readRequired(tx, ctx, row.id) };
    });
  } catch (error) {
    for (const violation of postgresViolations(error)) {
      if (violation.constraint === 'endpoint_clients_workspace_kind_name_key') {
        return { kind: 'name-taken' as const };
      }
    }
    throw error;
  }
}

async function insertAgents(
  tx: EndpointClientExecutor,
  ctx: ClientContext,
  clientId: string,
  agentIds: readonly string[],
): Promise<void> {
  // A `builder` client binds no agent, and drizzle refuses an empty insert.
  if (agentIds.length === 0) return;
  await tx
    .insert(endpointClientAgents)
    .values(agentIds.map((agentId) => ({ clientId, workspaceId: ctx.workspaceId, agentId })));
}

async function replaceAgents(
  tx: EndpointClientExecutor,
  ctx: ClientContext,
  clientId: string,
  agentIds: readonly string[],
): Promise<void> {
  await tx
    .delete(endpointClientAgents)
    .where(
      and(
        eq(endpointClientAgents.workspaceId, ctx.workspaceId),
        eq(endpointClientAgents.clientId, clientId),
      ),
    );
  await insertAgents(tx, ctx, clientId, agentIds);
}

function lockClient(tx: EndpointClientExecutor, ctx: ClientContext, id: string) {
  return tx.select().from(endpointClients).where(clientWhere(ctx, id)).for('update');
}

async function updateClient(
  ctx: ClientContext,
  id: string,
  patch: EndpointClientPatch,
): ReturnType<EndpointClientRepository['update']> {
  return ctx.db.transaction(async (tx) => {
    const current = (await lockClient(tx, ctx, id))[0];
    if (current === undefined) return { kind: 'not-found' as const };
    if (current.revokedAt !== null) return { kind: 'revoked' as const };
    const agentIds =
      patch.agentIds === undefined ? null : checkedAgentIds(current.kind, patch.agentIds);
    const toolNames =
      patch.toolNames === undefined ? undefined : checkedToolNames(current.kind, patch.toolNames);
    const oidcAudience =
      patch.oidcAudience === undefined
        ? undefined
        : checkedOidcAudience(current.kind, patch.oidcAudience);
    const redirectUris =
      patch.redirectUris === undefined ? undefined : checkedRedirectUris(patch.redirectUris);
    if (agentIds !== null) await replaceAgents(tx, ctx, id, agentIds);
    await tx
      .update(endpointClients)
      .set({
        updatedAt: sql`now()`,
        ...(toolNames === undefined ? {} : { toolNames }),
        ...(oidcAudience === undefined ? {} : { oidcAudience }),
        ...(redirectUris === undefined ? {} : { redirectUris }),
      })
      .where(clientWhere(ctx, id));
    return { kind: 'updated' as const, client: await readRequired(tx, ctx, id) };
  });
}

async function setClientSecretHash(
  ctx: ClientContext,
  id: string,
  secretHash: string,
  at: Date,
): ReturnType<EndpointClientRepository['setSecretHash']> {
  return ctx.db.transaction(async (tx) => {
    const current = (await lockClient(tx, ctx, id))[0];
    if (current === undefined) return { kind: 'not-found' as const };
    if (current.revokedAt !== null) return { kind: 'revoked' as const };
    await tx
      .update(endpointClients)
      .set({
        clientSecretHash: secretHash,
        clientSecretRotatedAt: sql`greatest(now(), ${at}::timestamptz)`,
      })
      .where(clientWhere(ctx, id));
    return { kind: 'set' as const, client: await readRequired(tx, ctx, id) };
  });
}

/** Revoke every not-yet-revoked key bound to the client, and the principals of those keys. */
async function revokeBoundKeys(
  tx: EndpointClientExecutor,
  ctx: ClientContext,
  clientId: string,
  revokedAt: Date,
): Promise<EndpointClientRevocation['revokedKeys']> {
  const { workspaceId } = ctx;
  const bound = tx
    .select({ id: endpointClientApiKeys.apiKeyId })
    .from(endpointClientApiKeys)
    .where(
      and(
        eq(endpointClientApiKeys.workspaceId, workspaceId),
        eq(endpointClientApiKeys.clientId, clientId),
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
  return revokedKeys;
}

async function revokeClient(
  ctx: ClientContext,
  id: string,
  at: Date,
): Promise<EndpointClientRevocation | null> {
  return ctx.db.transaction(async (tx) => {
    const current = (await lockClient(tx, ctx, id))[0];
    if (current === undefined) return null;
    if (current.revokedAt !== null) {
      return { client: await readRequired(tx, ctx, id), revokedKeys: [] };
    }
    const updated = await tx
      .update(endpointClients)
      .set({ revokedAt: sql`greatest(now(), ${at}::timestamptz)` })
      .where(clientWhere(ctx, id))
      .returning({ revokedAt: endpointClients.revokedAt });
    const revokedAt = updated[0]?.revokedAt;
    if (revokedAt === undefined || revokedAt === null) {
      throw new Error('endpoint client revocation returned no timestamp');
    }
    const revokedKeys = await revokeBoundKeys(tx, ctx, id, revokedAt);
    return { client: await readRequired(tx, ctx, id), revokedKeys };
  });
}

export function createDatabaseEndpointClientRepositoryProvider(
  db: Database,
): EndpointClientRepositoryProvider {
  return {
    forScope(scope) {
      const { workspaceId } = requireWorkspaceScope(scope, 'EndpointClientRepositoryProvider');
      const ctx: ClientContext = { db, workspaceId };
      return {
        list: () => listClients(ctx),
        get: (id) => readOne(db, ctx, id),
        findByName: (kind, name) => findClientByName(ctx, kind, name),
        create: (input) => createClient(ctx, input),
        update: (id, patch) => updateClient(ctx, id, patch),
        setSecretHash: (id, secretHash, at) => setClientSecretHash(ctx, id, secretHash, at),
        revoke: (id, at) => revokeClient(ctx, id, at),
      };
    },
  };
}
