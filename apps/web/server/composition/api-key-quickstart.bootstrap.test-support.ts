import {
  BASE_URL,
  DAY_MS,
  PINNED_NOW,
  serve,
  AGENT_BODY,
} from './api-key-quickstart.transport.test-support';
import crypto from 'node:crypto';
import {
  apiKeys,
  runtimeProfiles,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { applicationContext } from '../application-context';
import { mintApiKey } from '../rbac/api-key';
import { getRunApi } from '../runs/environment';
import { installTestRunApi } from '../application-context-fixtures';

export async function seedQuickstartKeys(
  isolated: IsolatedTestDatabase,
  workspaceId: string,
  keys: Map<string, { readonly presented: string; readonly id: string }>,
) {
  const fixtures = [
    { name: 'builder', role: 'builder' },
    { name: 'viewer', role: 'viewer' },
    { name: 'owner', role: 'owner' },
    { name: 'revoked', role: 'owner' },
    { name: 'expiring', role: 'owner' },
    { name: 'expired', role: 'owner' },
  ] as const;

  for (const fixture of fixtures) {
    const minted = await mintApiKey();
    const id = crypto.randomUUID();
    await isolated.db.insert(apiKeys).values({
      id,
      workspaceId,
      name: `quickstart-${fixture.name}`,
      role: fixture.role,
      keyPrefix: minted.keyPrefix,
      keyHash: minted.keyHash,
      // Minted two days before the pinned instant, so every lifecycle below respects
      // `expires_at > created_at` and `revoked_at >= created_at`: one key that expires one
      // millisecond after the pinned instant, one that expires exactly at it — the two sides of
      // the boundary — and one revoked the day before.
      ...(fixture.name === 'owner' || fixture.name === 'builder' || fixture.name === 'viewer'
        ? {}
        : { createdAt: new Date(PINNED_NOW.getTime() - 2 * DAY_MS) }),
      ...(fixture.name === 'expiring' ? { expiresAt: new Date(PINNED_NOW.getTime() + 1) } : {}),
      ...(fixture.name === 'expired' ? { expiresAt: PINNED_NOW } : {}),
      ...(fixture.name === 'revoked' ? { revokedAt: new Date(PINNED_NOW.getTime() - DAY_MS) } : {}),
    });
    keys.set(fixture.name, { presented: minted.presented, id });
  }
}

export async function configureQuickstart(env: NodeJS.ProcessEnv, databaseUrl: string) {
  env['DATABASE_URL'] = databaseUrl;

  env['SESSION_SECRET'] = 'api-key-quickstart-test-secret-at-least-32-characters';

  env['MASTER_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');

  env['RUNNER_URL'] = 'http://127.0.0.1:9';

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

  const { register } = await import('./register');

  const composition = await register();

  if (composition === undefined) throw new Error('composition registration was skipped');
  return composition;
}

export async function prepareQuickstartModel(
  isolated: IsolatedTestDatabase,
  workspaceId: string,
  modelListUrl: string,
) {
  const models = applicationContext()?.models;

  if (models?.kind !== 'serving') throw new Error('the composition installed no models API');

  const modelsRuntime = models.runtime;

  const connection = await modelsRuntime.models.forWorkspace(workspaceId).create({
    name: 'quickstart-anthropic',
    provider: 'anthropic',
    apiKey: 'sk-ant-quickstart-fixture',
    config: { baseUrl: modelListUrl },
  });

  if (connection.kind !== 'created') throw new Error(`model connection: ${connection.kind}`);

  const [profile] = await isolated.db
    .insert(runtimeProfiles)
    .values({
      workspaceId,
      name: 'quickstart-local',
      driver: 'local',
      networkPolicy: 'none',
      filesystem: 'read-only',
    })
    .returning({ id: runtimeProfiles.id });

  if (profile === undefined) throw new Error('the runtime profile was not created');
  return { modelConnectionId: connection.connection.id, runtimeProfileId: profile.id };
}

export function installQuickstartRunDelivery() {
  // The run API the composition installed, whole — its authentication, agent lookup, sessions
  // and PostgreSQL store — with only the runtime's part settled in-process: running, one relayed
  // event, completed.
  const installed = getRunApi();

  if (installed === null) throw new Error('the composition installed no run API');

  const { store } = installed;

  installTestRunApi({
    ...installed,
    launch: ({ run }) => {
      void (async () => {
        await store.markRunning(run.id);
        await store.append(run.id, { type: 'assistant', data: { text: 'Three things.' } });
        await store.finish(run.id, 'completed', null, true);
      })();
    },
  });
}

export async function createQuickstartAgents(
  key: (name: string) => string,
  runnable: { modelConnectionId: string; runtimeProfileId: string },
) {
  // As `aw agents create` would, with each key: a Builder runs the agents it owns (§21), an
  // Owner or Admin runs any.
  const created: string[] = [];

  for (const [owner, name] of [
    ['builder', 'Researcher'],
    ['owner', 'Reviewer'],
  ] as const) {
    const response = await serve(`${BASE_URL}/api/agents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key(owner)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...AGENT_BODY, ...runnable, name }),
    });
    const text = await response.text();
    if (response.status !== 201) throw new Error(`creating ${name}: ${text}`);
    created.push((JSON.parse(text) as { id: string }).id);
  }
  return created;
}
