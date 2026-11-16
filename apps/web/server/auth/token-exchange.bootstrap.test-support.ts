import {
  BASE_URL,
  ISSUER,
  AUDIENCE,
  AGENT_MODEL,
  serve,
} from './token-exchange.transport.test-support';
import crypto from 'node:crypto';

import { type DatabaseRoot } from '@agent-workspace/core/db';
import {
  agentGrants,
  apiKeys,
  memberships,
  runtimeProfiles,
  userIdentities,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { applicationContext } from '../application-context';
import { installTestRunApi } from '../application-context-fixtures';
import { mintClientSecret } from '../oauth/tokens';
import { mintApiKey } from '../rbac/api-key';
import { getRunApi } from '../runs/environment';

export interface ExchangePeople {
  readonly workspaceId: string;
  readonly otherWorkspaceId: string;
  readonly ownerUserId: string;
  readonly personUserId: string;
  readonly strangerUserId: string;
}

export async function seedExchangePeople(db: IsolatedTestDatabase, people: ExchangePeople) {
  const { workspaceId, otherWorkspaceId, ownerUserId, personUserId, strangerUserId } = people;
  let ownerPrincipalId = '';
  await db.db.insert(workspaces).values([
    { id: workspaceId, slug: 'portal-home', name: 'Portal home' },
    { id: otherWorkspaceId, slug: 'elsewhere', name: 'Elsewhere' },
  ]);

  await db.db.insert(users).values([
    { id: ownerUserId, email: 'owner@portal.test', name: 'Owner' },
    { id: personUserId, email: 'ada@portal.test', name: 'Ada' },
    { id: strangerUserId, email: 'bo@elsewhere.test', name: 'Bo' },
  ]);

  await db.db.transaction(async (tx) => {
    for (const [userId, wsId, role] of [
      [ownerUserId, workspaceId, 'owner'],
      [personUserId, workspaceId, 'viewer'],
      [strangerUserId, otherWorkspaceId, 'owner'],
    ] as const) {
      const membershipId = crypto.randomUUID();
      await tx.insert(memberships).values({ id: membershipId, workspaceId: wsId, userId, role });
      const [principal] = await tx
        .insert(workspacePrincipals)
        .values({ workspaceId: wsId, kind: 'membership', membershipId })
        .returning({ id: workspacePrincipals.id });
      if (principal === undefined) throw new Error('fixture: no principal');
      if (userId === ownerUserId) ownerPrincipalId = principal.id;
    }
  });

  await db.db.insert(userIdentities).values([
    { issuer: ISSUER, subject: 'person-sub', userId: personUserId },
    { issuer: ISSUER, subject: 'stranger-sub', userId: strangerUserId },
  ]);

  const ownerKey = await mintApiKey();

  await db.db.insert(apiKeys).values({
    workspaceId,
    name: 'fixture-owner',
    role: 'owner',
    keyPrefix: ownerKey.keyPrefix,
    keyHash: ownerKey.keyHash,
  });
  return { ownerPrincipalId, ownerKey };
}

export async function configureExchange(env: NodeJS.ProcessEnv, databaseUrl: string) {
  env['DATABASE_URL'] = databaseUrl;

  env['SESSION_SECRET'] = 'token-exchange-integration-secret-at-least-32-characters';

  env['MASTER_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');

  env['RUNNER_URL'] = 'http://127.0.0.1:9';

  env['OIDC_ISSUER_URL'] = ISSUER;

  env['OIDC_CLIENT_ID'] = 'platform-browser';

  env['OIDC_CLIENT_SECRET'] = 'platform-browser-secret';

  env['OIDC_REDIRECT_URI'] = `${BASE_URL}/api/auth/callback`;

  for (const name of [
    'AW_STORAGE_URL',
    'AW_RUNTIME_VERIFICATION_FILE',
    'GATEWAY_TOKEN_SECRET',
    'NEXT_RUNTIME',
    'RUNNER_MANAGER_TOKEN',
    'RUNNER_MANAGER_URL',
  ] as const) {
    delete env[name];
  }

  const { register } = await import('../composition/register');

  const composition = await register();

  if (composition === undefined) throw new Error('composition registration was skipped');
  return composition;
}

export async function prepareExchangeModel(
  db: IsolatedTestDatabase,
  workspaceId: string,
  modelListUrl: string,
) {
  const models = applicationContext()?.models;

  if (models?.kind !== 'serving') throw new Error('the composition installed no models API');

  const connection = await models.runtime.models.forWorkspace(workspaceId).create({
    name: 'portal-anthropic',
    provider: 'anthropic',
    apiKey: 'sk-ant-portal-fixture',
    config: { baseUrl: modelListUrl },
  });

  if (connection.kind !== 'created') throw new Error(`model connection: ${connection.kind}`);

  const [profile] = await db.db
    .insert(runtimeProfiles)
    .values({
      workspaceId,
      name: 'portal-local',
      driver: 'local',
      networkPolicy: 'none',
      filesystem: 'read-only',
    })
    .returning({ id: runtimeProfiles.id });

  if (profile === undefined) throw new Error('the runtime profile was not created');
  return { modelConnectionId: connection.connection.id, runtimeProfileId: profile.id };
}

export function installExchangeRunDelivery() {
  const installed = getRunApi();

  if (installed === null) throw new Error('the composition installed no run API');

  const { store } = installed;

  installTestRunApi({
    ...installed,
    launch: ({ run }) => {
      void (async () => {
        await store.markRunning(run.id);
        await store.finish(run.id, 'completed', null, true);
      })();
    },
  });
}

export async function createExchangeAgents(
  db: IsolatedTestDatabase,
  context: {
    workspaceId: string;
    personUserId: string;
    ownerKey: string;
    modelConnectionId: string;
    runtimeProfileId: string;
  },
) {
  const { workspaceId, personUserId } = context;

  const created: string[] = [];

  for (const name of ['Granted', 'Ungranted', 'Unbound']) {
    const response = await serve('POST', '/api/agents', context.ownerKey, {
      name,
      instructions: 'Answer briefly.',
      model: AGENT_MODEL,
      modelConnectionId: context.modelConnectionId,
      runtimeProfileId: context.runtimeProfileId,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });
    const text = await response.text();
    if (response.status !== 201) throw new Error(`creating ${name}: ${text}`);
    created.push((JSON.parse(text) as { id: string }).id);
  }

  const [grantedAgent = '', ungrantedAgent = '', unboundAgent = ''] = created;

  // The person may run the granted agent and the unbound one; the client binds the first two.
  await db.db.insert(agentGrants).values([
    { workspaceId, agentId: grantedAgent, userId: personUserId },
    { workspaceId, agentId: unboundAgent, userId: personUserId },
  ]);
  return { grantedAgent, ungrantedAgent, unboundAgent };
}

export async function createExchangeClient(
  root: DatabaseRoot,
  context: {
    workspaceId: string;
    ownerPrincipalId: string;
    grantedAgent: string;
    ungrantedAgent: string;
  },
) {
  const { workspaceId, ownerPrincipalId, grantedAgent, ungrantedAgent } = context;

  const scope = await root.scopes.forWorkspaceId(workspaceId);

  if (scope === null) throw new Error('workspace did not resolve');

  const clients = root.endpointClients.forScope(scope);

  const client = await clients.create({
    name: 'portal',
    kind: 'app-backend',
    agentIds: [grantedAgent, ungrantedAgent],
    oidcAudience: AUDIENCE,
    actsForPrincipalId: ownerPrincipalId,
    createdByPrincipalId: ownerPrincipalId,
  });

  if (client.kind !== 'created') throw new Error('fixture: client creation failed');

  const clientId = client.client.id;

  const minted = await mintClientSecret();

  const clientSecret = minted.presented;

  await clients.setSecretHash(clientId, minted.secretHash, new Date());
  return { clientId, clientSecret };
}
