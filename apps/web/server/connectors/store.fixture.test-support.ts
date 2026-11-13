import crypto from 'node:crypto';
import {
  createIsolatedTestDatabase,
  createDatabaseMcpServerRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
} from '@agent-workspace/core/db/unscoped';
import { createSecretsService } from '@agent-workspace/core/secrets';
import { createRepositoryConnectorsStoreProvider } from './store';

export async function createConnectorStoreFixture(env: NodeJS.ProcessEnv) {
  const workspace = { id: crypto.randomUUID(), slug: 'w2cp05-store', name: 'Store' };
  const OWNER_ID = crypto.randomUUID();
  const MEMBERSHIP_ID = crypto.randomUUID();
  const PRINCIPAL_ID = crypto.randomUUID();
  const PLAINTEXT_MARKER = 'sk-ant-ACCEPTANCE-CRITERION-2-DO-NOT-LEAK-9f3c7a1d';

  const isolated = await createIsolatedTestDatabase('aw_w2cp05_store');
  await isolated.db.insert(workspaces).values([workspace]);
  await isolated.db
    .insert(users)
    .values([{ id: OWNER_ID, email: `${OWNER_ID}@example.test`, name: 'Store Owner' }]);
  await isolated.db.transaction(async (tx) => {
    await tx
      .insert(memberships)
      .values([{ id: MEMBERSHIP_ID, workspaceId: workspace.id, userId: OWNER_ID, role: 'owner' }]);
    await tx.insert(workspacePrincipals).values({
      id: PRINCIPAL_ID,
      workspaceId: workspace.id,
      kind: 'membership',
      membershipId: MEMBERSHIP_ID,
    });
  });

  const secretsService = await createSecretsService({
    DATABASE_URL: isolated.url,
    MASTER_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  });

  const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
  const provider = createRepositoryConnectorsStoreProvider({
    mcpServers: createDatabaseMcpServerRepositoryProvider(isolated.db),
    secrets: secretsService,
    scopes,
  });
  const store = provider.forWorkspace(workspace.id);

  return {
    env,
    isolated,
    secretsService,
    store,
    workspace,
    OWNER_ID,
    MEMBERSHIP_ID,
    PRINCIPAL_ID,
    PLAINTEXT_MARKER,
  };
}
export type ConnectorStoreFixture = Awaited<ReturnType<typeof createConnectorStoreFixture>>;
