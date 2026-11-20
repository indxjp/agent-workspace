import crypto from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseDirectoryRoot } from './directory.js';
import {
  createDatabaseEndpointClientRepositoryProvider,
  type EndpointClientRepository,
} from './endpoint-clients.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { postgresViolations, type PostgresViolation } from './violations.js';

type CreateInput = Parameters<EndpointClientRepository['create']>[0];
type ClientRecord = Extract<
  Awaited<ReturnType<EndpointClientRepository['create']>>,
  { kind: 'created' }
>['client'];

const agentPermissions = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

const fixtureIds = () => ({
  workspaceId: crypto.randomUUID(),
  otherWorkspaceId: crypto.randomUUID(),
  userId: crypto.randomUUID(),
  principalId: crypto.randomUUID(),
  otherPrincipalId: crypto.randomUUID(),
  agentA: crypto.randomUUID(),
  agentB: crypto.randomUUID(),
  foreignAgent: crypto.randomUUID(),
});

type FixtureIds = ReturnType<typeof fixtureIds>;

/** An owner membership and its principal in one workspace. */
async function insertOwner(
  isolated: IsolatedTestDatabase,
  owner: { workspaceId: string; userId: string; principalId: string },
): Promise<void> {
  const membershipId = crypto.randomUUID();
  const { workspaceId, userId, principalId } = owner;
  await isolated.db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx.insert(workspacePrincipals).values({
      id: principalId,
      workspaceId,
      kind: 'membership',
      membershipId,
    });
  });
}

/** An agent row owned by `ownerPrincipalId` in `workspaceId`. */
function agentRow(
  id: string,
  workspaceId: string,
  ownerPrincipalId: string,
  createdBy: string,
  name = `agent ${id}`,
) {
  return {
    id,
    workspaceId,
    name,
    instructions: '',
    ownerPrincipalId,
    createdBy,
    permissions: agentPermissions,
  };
}

/** Two tenants, one owner in each, and two agents plus a foreign one. */
async function seedTenants(isolated: IsolatedTestDatabase, ids: FixtureIds): Promise<void> {
  const { workspaceId, otherWorkspaceId, userId, principalId, otherPrincipalId } = ids;
  await isolated.db.insert(workspaces).values([
    { id: workspaceId, slug: workspaceId, name: 'Endpoints' },
    { id: otherWorkspaceId, slug: otherWorkspaceId, name: 'Other' },
  ]);
  await isolated.db
    .insert(users)
    .values({ id: userId, email: `${userId}@example.com`, name: 'Owner' });
  await insertOwner(isolated, { workspaceId, userId, principalId });
  await insertOwner(isolated, {
    workspaceId: otherWorkspaceId,
    userId,
    principalId: otherPrincipalId,
  });
  await isolated.db
    .insert(agents)
    .values([
      agentRow(ids.agentA, workspaceId, principalId, userId),
      agentRow(ids.agentB, workspaceId, principalId, userId),
      agentRow(ids.foreignAgent, otherWorkspaceId, otherPrincipalId, userId),
    ]);
}

/** Shared state and helpers for the EndpointClientRepository database tests. */
export function createEndpointClientFixture() {
  let isolated: IsolatedTestDatabase | undefined;
  const ids = fixtureIds();
  const base = { actsForPrincipalId: ids.principalId, createdByPrincipalId: ids.principalId };

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_endpoint_clients');
    await seedTenants(isolated, ids);
  }, 180_000);

  afterAll(async () => isolated?.close());

  const database = (): IsolatedTestDatabase => {
    if (isolated === undefined) throw new Error('the test database is not ready');
    return isolated;
  };

  const directory = () => createDatabaseDirectoryRoot(database().db);

  async function clientsFor(workspace: string) {
    const scope = await createDatabaseWorkspaceScopeResolver(database().db).forWorkspaceId(
      workspace,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    return createDatabaseEndpointClientRepositoryProvider(database().db).forScope(scope);
  }

  /** Create a client and fail the test unless it was created. */
  async function createClient(
    clients: EndpointClientRepository,
    input: Omit<CreateInput, 'actsForPrincipalId' | 'createdByPrincipalId'>,
  ): Promise<ClientRecord> {
    const created = await clients.create({ ...base, ...input });
    if (created.kind !== 'created') throw new Error('expected created');
    return created.client;
  }

  /** Mint a key bound to `clientId`, with a random prefix and hash unless given. */
  function mintKey(
    clientId: string,
    name: string,
    options: { workspace?: string; keyPrefix?: string; keyHash?: string } = {},
  ) {
    return directory()
      .forWorkspace(options.workspace ?? ids.workspaceId)
      .createEndpointApiKey({
        name,
        role: 'builder',
        keyPrefix: options.keyPrefix ?? `pfx_${crypto.randomUUID().slice(0, 8)}`,
        keyHash: options.keyHash ?? crypto.randomBytes(32).toString('hex'),
        expiresAt: null,
        endpointClientId: clientId,
        actsForPrincipalId: ids.principalId,
      });
  }

  /** Mint a key and fail the test unless it was created. */
  async function mintCreatedKey(
    clientId: string,
    name: string,
    keyPrefix: string,
    keyHash: string,
  ) {
    const minted = await mintKey(clientId, name, { keyPrefix, keyHash });
    if (minted.kind !== 'created') throw new Error('expected created');
    return minted;
  }

  /** The violations a refused write raised. */
  async function violationsOf(write: Promise<unknown>): Promise<readonly PostgresViolation[]> {
    try {
      await write;
    } catch (error) {
      return [...postgresViolations(error)];
    }
    throw new Error('the write was expected to be refused');
  }

  /** Insert an extra agent in the main workspace. */
  async function insertAgent(id: string, name: string): Promise<void> {
    await database()
      .db.insert(agents)
      .values(agentRow(id, ids.workspaceId, ids.principalId, ids.userId, name));
  }

  /** Raw insert into endpoint_clients, resolving to the violations it raised. */
  function rawInsertViolations(kind: string, toolNames: string | null) {
    return violationsOf(
      database().db.execute(
        sql`insert into endpoint_clients
              (workspace_id, name, kind, tool_names, acts_for_principal_id, created_by_principal_id)
            values (${ids.workspaceId}, ${`raw-${kind}`}, ${kind}, ${toolNames}::text[],
                    ${ids.principalId}, ${ids.principalId})`,
      ),
    );
  }

  return {
    ...ids,
    base,
    get db() {
      return database().db;
    },
    clientsFor,
    createClient,
    directory,
    insertAgent,
    mintCreatedKey,
    mintKey,
    rawInsertViolations,
  };
}

export type EndpointClientFixture = ReturnType<typeof createEndpointClientFixture>;
