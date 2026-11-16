import { openDatabaseRoot, type DatabaseRoot, type WorkspaceScope } from '@agent-workspace/core/db';
import {
  agents,
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import {
  createInMemorySecretsService,
  createSecretsService,
  type SecretsService,
} from '@agent-workspace/core/secrets';
import { VERTEX_DEFAULT_MODEL } from '@indx-workspace/contracts/models';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import type { DiscoverModelsResult, ModelDiscovery } from '../models/discovery';
import { createRepositoryModelsStoreProvider, type ModelsStoreProvider } from '../models/store';
import {
  clearWebRuntimeRegistry,
  configureWebRuntimeRegistry,
  type WebRuntimeRegistry,
} from '../runtimes/registry';
import type { SetupInput, SetupResult, SetupRuntime } from '../setup/runtime';
import { installSetupApi } from './setup';
import { GOOD_KEY, GOOD_KEY_2, probes } from './setup-provider.test-support';
export const E2B_KEY = 'e2b_setup_827_first_key';

export const E2B_KEY_2 = 'e2b_setup_827_rotated_key';

export const E2B_ENDPOINT = 'https://api.e2b.dev';

export const BAD_KEY = 'sk-ant-setup-415-rejected';

const ADMIN_EMAIL = 'setup-415-admin@example.test';

const ADMIN_PASSWORD = 'setup-415-one-time-password';

export const SEEDED_MODEL = 'claude-sonnet-4-5';

export const CONNECTION_NAME = 'anthropic default';

export const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

const CONTROLLED_ENV = [
  'BOOTSTRAP_ADMIN',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'SESSION_SECRET',
  'WORKSPACE_SLUG',
] as const;

/** Model discovery as the provider answers it: `401` for every key but the accepted ones. */
const discover: ModelDiscovery = (resolved): Promise<DiscoverModelsResult> =>
  Promise.resolve(
    resolved.connection.provider === 'vertex' ||
      resolved.credential === GOOD_KEY ||
      resolved.credential === GOOD_KEY_2
      ? {
          ok: true,
          stale: false,
          models: [
            {
              connectionId: resolved.connection.id,
              providerModelId:
                resolved.connection.provider === 'vertex' ? VERTEX_DEFAULT_MODEL : SEEDED_MODEL,
              displayName: 'Claude Sonnet',
              capabilities: {
                streaming: true,
                toolUse: true,
                thinking: true,
                promptCaching: true,
                structuredOutput: true,
                contextManagement: true,
                webSearch: false,
                tokenCounting: true,
              },
            },
          ],
        }
      : {
          ok: false,
          reason: 'The provider rejected the API key (HTTP 401).',
          failure: { kind: 'credential-rejected', status: 401 },
        },
  );

/** The runtime registry every test but the timeout one runs against: one enabled local driver. */
export const LOCAL_REGISTRY: WebRuntimeRegistry = {
  list: () =>
    Promise.resolve([
      {
        id: 'local',
        label: 'Local',
        connectionExists: true,
        imageReachable: true,
        testPassed: true,
        state: 'enabled',
        reason: null,
        networkPolicies: null,
      },
    ]),
  test: (driverId) => Promise.resolve({ driverId, transcript: [], destroyed: true }),
};

export function setupInput(overrides: Partial<SetupInput> = {}): SetupInput {
  return {
    provider: 'anthropic',
    providerApiKey: GOOD_KEY,
    runtime: 'local',
    adminEmail: ADMIN_EMAIL,
    adminPassword: ADMIN_PASSWORD,
    agentName: 'Setup Wizard Agent',
    agentInstructions: 'Answer briefly.',
    ...overrides,
  };
}

export let isolated: IsolatedTestDatabase | undefined;

let root: DatabaseRoot | undefined;

export let models: ModelsStoreProvider;

export let secrets: SecretsService;

/** Database-backed, so a runtime profile's foreign key to its connection secret is real. */
export let runtimeSecrets: SecretsService;

/** Set to make every stored secret fail to decrypt, as a wrong master key would. */
export const decryption = { fails: false };

export let adminUserId = '';

const previousEnv = new Map<string, string | undefined>();

/** The fresh workspace each test sets up, and the ids of its seeded rows. */
export let workspace = {
  id: '',
  slug: '',
  generalAgentId: '',
  principalId: '',
  scope: null as WorkspaceScope | null,
};

export function db(): DatabaseRoot {
  if (root === undefined) throw new Error('the database root is not open');
  return root;
}

export function scope(): WorkspaceScope {
  if (workspace.scope === null) throw new Error('the fixture workspace has no scope');
  return workspace.scope;
}

/** The setup workflow {@link install} built last. */
let installed: SetupRuntime | null = null;

/** Install the setup workflow over `over`, and answer the runtime it installed. */
export async function install(
  over: DatabaseRoot,
  options: {
    readonly lockWaitMs?: number;
    readonly runtimeTestTimeoutMs?: number;
    readonly policyCeiling?: ProjectPolicy;
    readonly runtimeSecrets?: SecretsService | null;
  } = {},
): Promise<SetupRuntime> {
  const setup = await installSetupApi(
    over,
    { models, discover },
    { probeDiscover: discover, runtimeSecrets, ...options },
  );
  if (setup.kind !== 'serving') throw new Error('the setup API was not installed');
  installed = setup.runtime;
  return installed;
}

/**
 * Run `work` with setup installed over the live root with `overrides` in front of it, so a late
 * write can be made to fail; the plain workflow is installed again afterwards.
 */
export async function withFailingRoot(
  overrides: Partial<DatabaseRoot>,
  work: () => Promise<void>,
): Promise<void> {
  const live = db();
  await install(Object.assign(Object.create(live) as DatabaseRoot, overrides));
  try {
    await work();
  } finally {
    await install(live);
  }
}

export async function complete(input: SetupInput): Promise<SetupResult> {
  if (installed === null) throw new Error('the setup API was not installed');
  return installed.complete(input);
}

/** Every row setup writes, as the workspace holds them now. */
export async function snapshot() {
  const store = models.forWorkspace(workspace.id);
  const connections = await store.list();
  const credentials = await Promise.all(
    connections.map(async (connection) => (await store.resolve(connection.id))?.credential),
  );
  const agentRows = await db().agents.forScope(scope()).list();
  return {
    connections: connections.map((connection, index) => ({
      id: connection.id,
      name: connection.name,
      ready: connection.ready,
      credential: credentials[index] ?? null,
    })),
    orphanedSecrets: (await store.reconcileOrphanedCredentials()).orphanedSecretNames,
    profiles: (await db().runtimeProfiles.forScope(scope()).list()).map((profile) => profile.name),
    agents: agentRows.map((agent) => ({
      id: agent.id,
      name: agent.name,
      modelConnectionId: agent.modelConnectionId,
      model: agent.model,
      runtimeProfileId: agent.runtimeProfileId,
    })),
    workspaceDefault: await db().getWorkspaceModelDefault(workspace.id),
    setupAgentId: await db().getWorkspaceSetupAgentId(workspace.id),
  };
}

/** The state a fresh project has before setup: the seeded General agent and nothing else. */
export async function expectUntouched(): Promise<void> {
  expect(await snapshot()).toEqual({
    connections: [],
    orphanedSecrets: [],
    profiles: [],
    agents: [
      {
        id: workspace.generalAgentId,
        name: 'General',
        modelConnectionId: null,
        model: null,
        runtimeProfileId: null,
      },
    ],
    workspaceDefault: null,
    setupAgentId: null,
  });
}

/** One ready setup connection holding the accepted key, used by default, wizard and General. */
export async function expectOneWorkingConnection(
  agentId: string,
  keys: readonly string[] = [GOOD_KEY],
): Promise<string> {
  const state = await snapshot();
  expect(state.connections).toHaveLength(1);
  const [connection] = state.connections;
  expect(connection).toMatchObject({ name: CONNECTION_NAME, ready: true });
  expect(keys).toContain(connection?.credential);
  const connectionId = connection?.id ?? '';
  expect(state.orphanedSecrets).toEqual([]);
  expect(state.workspaceDefault).toEqual({ connectionId, model: SEEDED_MODEL });
  expect(state.setupAgentId).toBe(agentId);
  const wizard = state.agents.find((agent) => agent.id === agentId);
  expect(wizard).toMatchObject({ modelConnectionId: connectionId, model: SEEDED_MODEL });
  const general = state.agents.find((agent) => agent.name === 'General');
  // General either names the working connection or inherits the workspace default, which does.
  expect([null, connectionId]).toContain(general?.modelConnectionId);
  expect(general?.runtimeProfileId).toBe(wizard?.runtimeProfileId);
  return connectionId;
}
export function registerSetupFixture(): void {
  beforeAll(async () => {
    for (const name of CONTROLLED_ENV) previousEnv.set(name, process.env[name]);
    isolated = await createIsolatedTestDatabase('aw_setup_415');
    const [user] = await isolated.db
      .insert(users)
      .values({ email: ADMIN_EMAIL, name: 'Setup admin' })
      .returning({ id: users.id });
    if (user === undefined) throw new Error('the administrator was not created');
    adminUserId = user.id;
    root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
    secrets = createInMemorySecretsService();
    runtimeSecrets = await createSecretsService({
      MASTER_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
      DATABASE_URL: isolated.url,
    });
    // The store reads secrets through this, so a test can make a stored one undecryptable.
    const reader = secrets;
    const readingSecrets: SecretsService = Object.assign(Object.create(reader) as SecretsService, {
      resolveByName: (...args: Parameters<SecretsService['resolveByName']>) =>
        decryption.fails
          ? Promise.reject(Object.assign(new Error('unsupported state'), { name: 'DecryptError' }))
          : reader.resolveByName(...args),
    });
    models = createRepositoryModelsStoreProvider({
      repositories: root.modelConnections,
      scopes: root.scopes,
      secrets: readingSecrets,
    });
    await install(root);
    configureWebRuntimeRegistry(LOCAL_REGISTRY);
    process.env['BOOTSTRAP_ADMIN'] = ADMIN_EMAIL;
    process.env['BOOTSTRAP_ADMIN_PASSWORD'] = ADMIN_PASSWORD;
    process.env['SESSION_SECRET'] = 'setup-415-test-session-secret-of-enough-length';
  });
  beforeEach(async () => {
    if (isolated === undefined) throw new Error('the isolated database is not open');
    const id = crypto.randomUUID();
    const slug = `setup-415-${id.slice(0, 8)}`;
    await isolated.db.insert(workspaces).values({ id, slug, name: 'Setup 415' });
    const [membership] = await isolated.db
      .insert(memberships)
      .values({ workspaceId: id, userId: adminUserId, role: 'owner' })
      .returning({ id: memberships.id });
    if (membership === undefined) throw new Error('the membership was not created');
    // The membership's principal is created with it (the `workspace_principals` trigger).
    const [principal] = await isolated.db
      .select({ id: workspacePrincipals.id })
      .from(workspacePrincipals)
      .where(eq(workspacePrincipals.membershipId, membership.id));
    if (principal === undefined) throw new Error('the principal was not created');
    const [general] = await isolated.db
      .insert(agents)
      .values({
        workspaceId: id,
        name: 'General',
        instructions: '',
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
        ownerPrincipalId: principal.id,
        createdBy: adminUserId,
      })
      .returning({ id: agents.id });
    if (general === undefined) throw new Error('the General agent was not created');
    process.env['WORKSPACE_SLUG'] = slug;
    workspace = {
      id,
      slug,
      generalAgentId: general.id,
      principalId: principal.id,
      scope: await db().scopes.forWorkspaceId(id),
    };
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    probes.peak = 0;
    decryption.fails = false;
  });
  afterAll(async () => {
    clearWebRuntimeRegistry();
    await runtimeSecrets.close();
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (isolated === undefined) return;
    await closeIsolatedTestResources(isolated, ...(root === undefined ? [] : [root]));
  });
}
