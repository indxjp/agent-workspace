/** The templates world over a real PostgreSQL: the repository stores on one isolated database. */
import crypto from 'node:crypto';

import type { DatabaseRoot } from '@agent-workspace/core/db';
import {
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { createSecretsService, type SecretsService } from '@agent-workspace/core/secrets';

import {
  createRepositoryAgentGrantStoreProvider,
  createRepositoryAgentResourceStoreProvider,
  createRepositoryAgentStoreProvider,
} from '../../agents/store';
import { createRepositoryConnectorsStoreProvider } from '../../connectors/store';
import { createRepositoryModelsStoreProvider } from '../../models/store';
import { createRepositoryRuntimeProfileStoreProvider } from '../../runtimes/store';
import { createPostgresDirectory } from '../../rbac/postgres-directory';
import { createResourceCatalogStoreProvider } from '../../storage/store';
import type { DemoSandbox } from './ports';
import type { DemoTemplatesWorld } from './templates.contract';
import { buildWorld } from './templates.world.build.test-support';
import { TEST_DEMO_SANDBOX, type MadeWorkspace } from './templates.world.parts.test-support';

/** Insert a workspace with `ownerEmail` as its one Owner, and say who they are. */
async function insertWorkspaceWithOwner(
  isolated: IsolatedTestDatabase,
  slug: string,
  ownerEmail: string,
): Promise<MadeWorkspace> {
  const id = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await isolated.db.insert(workspaces).values({ id, slug, name: slug });
  await isolated.db.insert(users).values({ id: userId, email: ownerEmail, name: 'Template owner' });
  await isolated.db.transaction(async (tx) => {
    await tx
      .insert(memberships)
      .values({ id: membershipId, workspaceId: id, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId: id, kind: 'membership', membershipId });
  });
  return { id, principalId, userId };
}

function createPostgresTemplatesWorld(
  database: DatabaseRoot,
  isolated: IsolatedTestDatabase,
  secrets: SecretsService,
  sandbox: Partial<DemoSandbox>,
): DemoTemplatesWorld {
  const scopes = database.scopes;
  const catalogs = createResourceCatalogStoreProvider({
    repositories: database.resourceCatalogs,
    scopes,
  });
  return buildWorld(
    {
      directory: createPostgresDirectory(database.directory),
      agents: createRepositoryAgentStoreProvider({ repositories: database.agents, scopes }),
      resources: createRepositoryAgentResourceStoreProvider({
        repositories: database.agentResources,
        scopes,
      }),
      grants: createRepositoryAgentGrantStoreProvider({
        repositories: database.agentGrants,
        scopes,
      }),
      connectors: createRepositoryConnectorsStoreProvider({
        mcpServers: database.mcpServers,
        secrets,
        scopes,
      }),
      models: createRepositoryModelsStoreProvider({
        repositories: database.modelConnections,
        scopes,
        secrets,
      }),
      runtimeProfiles: createRepositoryRuntimeProfileStoreProvider({
        repositories: database.runtimeProfiles,
        scopes,
      }),
      catalogs: (workspaceId) => catalogs.forWorkspace(workspaceId),
      skillCatalogs: (workspaceId) => catalogs.forWorkspace(workspaceId),
      makeWorkspace: (slug, ownerEmail) => insertWorkspaceWithOwner(isolated, slug, ownerEmail),
      async workspaceIdForSlug(slug) {
        return (await scopes.forWorkspaceSlug(slug))?.workspaceId ?? null;
      },
    },
    { ...TEST_DEMO_SANDBOX, ...sandbox },
  );
}

export async function openPostgresTemplatesWorld(): Promise<{
  /** A world over the one database, whose provisioner runs on `sandbox` (the test defaults, changed by it). */
  readonly world: (sandbox?: Partial<DemoSandbox>) => Promise<DemoTemplatesWorld>;
  readonly close: () => Promise<void>;
}> {
  const { openDatabaseRoot } = await import('@agent-workspace/core/db');
  const isolated = await createIsolatedTestDatabase('aw_demo_templates');
  const database = await openDatabaseRoot({ DATABASE_URL: isolated.url });
  // One secrets service (it opens its own pool) for every world over this database.
  const secrets = await createSecretsService({
    DATABASE_URL: isolated.url,
    MASTER_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  });
  return {
    world: (sandbox = {}) =>
      Promise.resolve(createPostgresTemplatesWorld(database, isolated, secrets, sandbox)),
    close: async () => {
      await secrets.close();
      await database.close();
      await isolated.close();
    },
  };
}
