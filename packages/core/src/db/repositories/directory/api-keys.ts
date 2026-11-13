import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../../client.js';
import { apiKeys } from '../../schema/api-keys.js';
import { endpointClientAgents } from '../../schema/endpoint-client-agents.js';
import { endpointClientApiKeys } from '../../schema/endpoint-client-api-keys.js';
import { endpointClients, type EndpointClientKind } from '../../schema/endpoint-clients.js';
import type { MembershipRole } from '../../schema/memberships.js';
import { workspacePrincipals } from '../../schema/workspace-principals.js';
import type {
  DatabaseWorkspaceDirectory,
  DirectoryApiKeyRecord,
  DirectoryEndpointScope,
} from '../directory.js';
import {
  endpointBindings,
  isActiveMembershipPrincipal,
  isConstraint,
  KEY_COLUMNS,
  KEY_ROW_COLUMNS,
  type Transaction,
} from './queries.js';

type Directory = DatabaseWorkspaceDirectory;

/** Insert one `api_keys` row and its `workspace_principals` row. Runs inside the caller's transaction. */
async function insertApiKey(
  tx: Transaction,
  workspaceId: string,
  input: {
    name: string;
    role: MembershipRole;
    keyPrefix: string;
    keyHash: string;
    expiresAt: Date | null;
  },
  actsForPrincipalId: string | undefined,
): Promise<Omit<DirectoryApiKeyRecord, 'endpointScope'>> {
  if (
    actsForPrincipalId !== undefined &&
    !(await isActiveMembershipPrincipal(tx, workspaceId, actsForPrincipalId))
  ) {
    throw new Error('An API key may act only for an active membership principal of its workspace.');
  }
  const rows = await tx
    .insert(apiKeys)
    .values({ ...input, workspaceId })
    .returning(KEY_ROW_COLUMNS);
  const key = rows[0];
  if (key === undefined) throw new Error('API key insert returned no row');
  const insertedPrincipal = await tx
    .insert(workspacePrincipals)
    .values({
      workspaceId,
      kind: 'api_key',
      apiKeyId: key.id,
      actsForPrincipalId: actsForPrincipalId ?? null,
    })
    .returning({
      principalId: workspacePrincipals.id,
      actsForPrincipalId: workspacePrincipals.actsForPrincipalId,
    });
  const principal = insertedPrincipal[0];
  if (principal === undefined) throw new Error('API-key principal insert returned no row');
  return {
    ...key,
    principalId: principal.principalId,
    actsForPrincipalId: principal.actsForPrincipalId,
  };
}

/** API keys joined to their principal, filtered by `where`. */
function selectApiKeys(db: Database, where: SQL | undefined) {
  return db
    .select(KEY_COLUMNS)
    .from(apiKeys)
    .innerJoin(
      workspacePrincipals,
      and(
        eq(workspacePrincipals.workspaceId, apiKeys.workspaceId),
        eq(workspacePrincipals.apiKeyId, apiKeys.id),
      ),
    )
    .where(where);
}

/** The `name-taken` outcome when `error` is the key-name uniqueness violation; any other error is rethrown. */
function refuseNameTaken(error: unknown, name: string): { kind: 'name-taken'; name: string } {
  if (isConstraint(error, 'api_keys_workspace_name_key')) return { kind: 'name-taken', name };
  throw error;
}

/**
 * The scope a new key bound to endpoint client `clientId` carries. Throws for a client that cannot
 * carry a key: an a2a client naming no agent, and `builder` or `app-backend` clients, which are
 * reached by an OAuth token only.
 */
export function endpointScopeForClient(
  clientId: string,
  client: { readonly kind: EndpointClientKind; readonly agentId: string | null },
): DirectoryEndpointScope {
  switch (client.kind) {
    case 'mcp-project':
      return { kind: 'mcp-project', clientId };
    case 'a2a-agent':
      if (client.agentId === null) {
        throw new Error('An a2a endpoint client must name exactly one agent.');
      }
      return { kind: 'a2a-agent', clientId, agentId: client.agentId };
    case 'builder':
      throw new Error('A builder endpoint client has no API key.');
    case 'app-backend':
      throw new Error('An app-backend endpoint client has no API key.');
    default: {
      const unreachable: never = client.kind;
      throw new Error(`unhandled endpoint client kind ${String(unreachable)}`);
    }
  }
}

/** Lock one endpoint client row of the workspace and read its kind, revocation and agent. */
async function lockEndpointClient(tx: Transaction, workspaceId: string, clientId: string) {
  const clients = await tx
    .select({
      kind: endpointClients.kind,
      revokedAt: endpointClients.revokedAt,
      agentId: endpointClientAgents.agentId,
    })
    .from(endpointClients)
    .leftJoin(
      endpointClientAgents,
      and(
        eq(endpointClientAgents.workspaceId, endpointClients.workspaceId),
        eq(endpointClientAgents.clientId, endpointClients.id),
      ),
    )
    .where(and(eq(endpointClients.workspaceId, workspaceId), eq(endpointClients.id, clientId)))
    .for('update', { of: endpointClients });
  return clients[0];
}

async function createEndpointApiKey(
  db: Database,
  workspaceId: string,
  input: Parameters<Directory['createEndpointApiKey']>[0],
): ReturnType<Directory['createEndpointApiKey']> {
  const { endpointClientId, actsForPrincipalId, ...keyInput } = input;
  try {
    return await db.transaction(async (tx) => {
      const client = await lockEndpointClient(tx, workspaceId, endpointClientId);
      if (client === undefined) {
        return { kind: 'no-such-endpoint-client' as const, id: endpointClientId };
      }
      if (client.revokedAt !== null) {
        return { kind: 'endpoint-client-revoked' as const, id: endpointClientId };
      }
      const scope = endpointScopeForClient(endpointClientId, client);
      const key = await insertApiKey(tx, workspaceId, keyInput, actsForPrincipalId);
      await tx
        .insert(endpointClientApiKeys)
        .values({ workspaceId, clientId: endpointClientId, apiKeyId: key.id });
      return { kind: 'created' as const, key: { ...key, endpointScope: scope } };
    });
  } catch (error) {
    return refuseNameTaken(error, input.name);
  }
}

/** Revoke an unrevoked key and its principal; `null` when the key was revoked concurrently. */
async function revokeKeyAndPrincipal(
  tx: Transaction,
  workspaceId: string,
  key: DirectoryApiKeyRecord,
  now: Date,
): Promise<DirectoryApiKeyRecord | null> {
  const rows = await tx
    .update(apiKeys)
    .set({ revokedAt: sql`greatest(now(), ${now}::timestamptz)` })
    .where(
      and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.id, key.id), isNull(apiKeys.revokedAt)),
    )
    .returning(KEY_ROW_COLUMNS);
  const row = rows[0];
  if (row === undefined || row.revokedAt === null) return null;
  const principalRows = await tx
    .update(workspacePrincipals)
    .set({ revokedAt: row.revokedAt })
    .where(
      and(
        eq(workspacePrincipals.workspaceId, workspaceId),
        eq(workspacePrincipals.id, key.principalId),
        eq(workspacePrincipals.apiKeyId, key.id),
      ),
    )
    .returning({ id: workspacePrincipals.id });
  if (principalRows.length !== 1) {
    throw new Error('API-key revocation updated no exact principal');
  }
  return {
    ...row,
    principalId: key.principalId,
    actsForPrincipalId: key.actsForPrincipalId,
    endpointScope: key.endpointScope,
  };
}

async function revokeApiKey(
  db: Database,
  workspaceId: string,
  id: string,
  now: Date,
): ReturnType<Directory['revokeApiKey']> {
  const existing = await selectApiKeys(
    db,
    and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.id, id)),
  ).limit(1);
  const found = existing[0];
  if (found === undefined) return { kind: 'no-such-key', id };
  const key: DirectoryApiKeyRecord = {
    ...found,
    endpointScope: (await endpointBindings(db, workspaceId, id)).get(id)?.scope ?? null,
  };
  if (key.revokedAt !== null) return { kind: 'already-revoked', key };
  const revoked = await db.transaction(async (tx) =>
    revokeKeyAndPrincipal(tx, workspaceId, key, now),
  );
  return revoked === null ? { kind: 'already-revoked', key } : { kind: 'revoked', key: revoked };
}

/** The API keys of one workspace, hosted and endpoint-bound. */
export function createApiKeyDirectory(
  db: Database,
  workspaceId: string,
): Pick<
  Directory,
  'listApiKeys' | 'createApiKey' | 'createEndpointApiKey' | 'revokeApiKey' | 'readApiKey'
> {
  return {
    async listApiKeys() {
      const rows = await selectApiKeys(db, eq(apiKeys.workspaceId, workspaceId)).orderBy(
        asc(apiKeys.name),
      );
      const bindings = await endpointBindings(db, workspaceId);
      return rows.map((row) => ({ ...row, endpointScope: bindings.get(row.id)?.scope ?? null }));
    },
    async createApiKey(input) {
      const { actsForPrincipalId, ...keyInput } = input;
      try {
        return await db.transaction(async (tx) => {
          const key = await insertApiKey(tx, workspaceId, keyInput, actsForPrincipalId);
          return { kind: 'created' as const, key: { ...key, endpointScope: null } };
        });
      } catch (error) {
        return refuseNameTaken(error, input.name);
      }
    },
    createEndpointApiKey: async (input) => createEndpointApiKey(db, workspaceId, input),
    revokeApiKey: async (id, now) => revokeApiKey(db, workspaceId, id, now),
    async readApiKey(id) {
      const rows = await selectApiKeys(
        db,
        and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.id, id)),
      ).limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      const bindings = await endpointBindings(db, workspaceId, id);
      return { ...row, endpointScope: bindings.get(id)?.scope ?? null };
    },
  };
}
