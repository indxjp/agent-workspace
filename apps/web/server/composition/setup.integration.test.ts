/**
 * Issue #415: first-run setup is atomic. `POST /api/setup` used to create the setup-owned model
 * connection and store the submitted key before it asked the provider whether the key works, so a
 * refused attempt (`422 provider_test_failed`) left a ready `anthropic default` holding the
 * rejected key. These tests run the installed setup workflow (`installSetupApi`) against
 * PostgreSQL: the agents, runtime profiles, model connections and workspace default are the real
 * repositories. The provider is the one substitution — the probe and discovery answer `401` to
 * every key but {@link GOOD_KEY} and {@link GOOD_KEY_2} — and the runtime registry reports one
 * enabled driver.
 */
import { captureLog } from '../telemetry/capture-log';
import { log as webLogger } from '../telemetry/logger';
import crypto from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabaseRoot, type DatabaseRoot, type WorkspaceScope } from '@agent-workspace/core/db';
import {
  agents,
  auditEvents,
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
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { eq } from 'drizzle-orm';

import { createRuntimeManagerClient } from '../compose/runtime-manager-client';
import { DomainError } from '../errors';
import { resolveRuntimeConnectionCredential } from '../runtimes/connections';
import type { DiscoverModelsResult, ModelDiscovery } from '../models/discovery';
import { createRepositoryModelsStoreProvider, type ModelsStoreProvider } from '../models/store';
import {
  clearWebRuntimeRegistry,
  configureWebRuntimeRegistry,
  type WebRuntimeRegistry,
} from '../runtimes/registry';
import type { SetupInput, SetupResult, SetupRuntime } from '../setup/runtime';

import { probeModelConnection } from '../models/probe';

import { installSetupApi } from './setup';

const { GOOD_KEY, GOOD_KEY_2, probes } = vi.hoisted(() => ({
  GOOD_KEY: 'sk-ant-setup-415-accepted',
  GOOD_KEY_2: 'sk-ant-setup-415-accepted-rotated',
  /** How many probes are in flight now, and the most that ever were at once. */
  probes: { active: 0, peak: 0 },
}));

vi.mock('../models/probe', () => ({
  probeModelConnection: vi.fn(async (resolved: { credential: string }) => {
    probes.active += 1;
    probes.peak = Math.max(probes.peak, probes.active);
    // Long enough for a second, unserialised setup to start its own probe meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 25));
    probes.active -= 1;
    return resolved.credential === GOOD_KEY || resolved.credential === GOOD_KEY_2
      ? { ok: true, status: 200, latencyMs: 1, message: 'Connection succeeded.' }
      : { ok: false, status: 401, latencyMs: 1, message: 'Provider returned HTTP 401.' };
  }),
}));

const E2B_KEY = 'e2b_setup_827_first_key';
const E2B_KEY_2 = 'e2b_setup_827_rotated_key';
const E2B_ENDPOINT = 'https://api.e2b.dev';
const BAD_KEY = 'sk-ant-setup-415-rejected';
const ADMIN_EMAIL = 'setup-415-admin@example.test';
const ADMIN_PASSWORD = 'setup-415-one-time-password';
const SEEDED_MODEL = 'claude-sonnet-4-5';
const CONNECTION_NAME = 'anthropic default';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn(
    '[composition/setup.integration.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so setup ' +
      'atomicity (issue #415) was not checked against PostgreSQL.',
  );
}

const CONTROLLED_ENV = [
  'BOOTSTRAP_ADMIN',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'SESSION_SECRET',
  'WORKSPACE_SLUG',
] as const;

/** Model discovery as the provider answers it: `401` for every key but the accepted ones. */
const discover: ModelDiscovery = (resolved): Promise<DiscoverModelsResult> =>
  Promise.resolve(
    resolved.credential === GOOD_KEY || resolved.credential === GOOD_KEY_2
      ? {
          ok: true,
          stale: false,
          models: [
            {
              connectionId: resolved.connection.id,
              providerModelId: SEEDED_MODEL,
              displayName: 'Claude Sonnet 4.5',
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
const LOCAL_REGISTRY: WebRuntimeRegistry = {
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

function setupInput(overrides: Partial<SetupInput> = {}): SetupInput {
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

describe.skipIf(!hasDatabase)('first-run setup is atomic (issue #415, PostgreSQL)', () => {
  let isolated: IsolatedTestDatabase | undefined;
  let root: DatabaseRoot | undefined;
  let models: ModelsStoreProvider;
  let secrets: SecretsService;
  /** Database-backed, so a runtime profile's foreign key to its connection secret is real. */
  let runtimeSecrets: SecretsService;
  /** Set to make every stored secret fail to decrypt, as a wrong master key would. */
  const decryption = { fails: false };
  let adminUserId = '';
  const previousEnv = new Map<string, string | undefined>();
  /** The fresh workspace each test sets up, and the ids of its seeded rows. */
  let workspace = {
    id: '',
    slug: '',
    generalAgentId: '',
    principalId: '',
    scope: null as WorkspaceScope | null,
  };

  function db(): DatabaseRoot {
    if (root === undefined) throw new Error('the database root is not open');
    return root;
  }

  function scope(): WorkspaceScope {
    if (workspace.scope === null) throw new Error('the fixture workspace has no scope');
    return workspace.scope;
  }

  /** The setup workflow {@link install} built last. */
  let installed: SetupRuntime | null = null;

  /** Install the setup workflow over `over`, and answer the runtime it installed. */
  async function install(
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
  async function withFailingRoot(
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

  async function complete(input: SetupInput): Promise<SetupResult> {
    if (installed === null) throw new Error('the setup API was not installed');
    return installed.complete(input);
  }

  /** Every row setup writes, as the workspace holds them now. */
  async function snapshot() {
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
      profiles: (await db().runtimeProfiles.forScope(scope()).list()).map(
        (profile) => profile.name,
      ),
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
  async function expectUntouched(): Promise<void> {
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
  async function expectOneWorkingConnection(
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

  it('a refused provider test persists nothing: no connection, credential or other write', async () => {
    const refused = await complete(setupInput({ providerApiKey: BAD_KEY }));
    expect(refused).toEqual({
      ok: false,
      status: 422,
      code: 'provider_test_failed',
      message: 'Provider returned HTTP 401.',
    });
    await expectUntouched();
  });

  it('probes and stores the provider base URL setup was given, and a refusal restores the stored one', async () => {
    const baseUrl = 'https://fake-provider.example.test';
    const first = await complete(setupInput({ providerBaseUrl: baseUrl }));
    if (!first.ok) throw new Error(`setup refused: ${first.code}`);
    expect(vi.mocked(probeModelConnection).mock.calls[0]?.[0].connection.config).toEqual({
      baseUrl,
    });
    const store = models.forWorkspace(workspace.id);
    expect((await store.get(first.modelConnectionId))?.config).toEqual({ baseUrl });

    // A retry that names another URL moves the row; one the provider refuses leaves it as it was.
    const other = 'https://other-provider.example.test';
    const refused = await complete(setupInput({ providerApiKey: BAD_KEY, providerBaseUrl: other }));
    expect(refused).toMatchObject({ ok: false, code: 'provider_test_failed' });
    expect((await store.get(first.modelConnectionId))?.config).toEqual({ baseUrl });
    const moved = await complete(setupInput({ providerBaseUrl: other }));
    if (!moved.ok) throw new Error(`setup refused: ${moved.code}`);
    expect(moved.modelConnectionId).toBe(first.modelConnectionId);
    expect((await store.get(first.modelConnectionId))?.config).toEqual({ baseUrl: other });
  });

  it('refuses over the policy ceiling before the setup lock: one audit row, nothing written (issue #535)', async () => {
    const live = db();
    const locked = vi.spyOn(live, 'withWorkspaceSetupLock');
    await install(live, { policyCeiling: { models: ['claude-opus-4-1'] } });
    try {
      expect(await complete(setupInput())).toEqual({
        ok: false,
        status: 403,
        code: 'policy_cannot_widen',
        message: `The first agent would be wider than this deployment's policy ceiling allows: model:${SEEDED_MODEL}`,
      });
    } finally {
      await install(live);
    }
    expect(locked).not.toHaveBeenCalled();
    await expectUntouched();
    if (isolated === undefined) throw new Error('the isolated database is not open');
    const rows = await isolated.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, workspace.id));
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'agent-changed',
        actorPrincipalId: workspace.principalId,
        actorUserId: adminUserId,
        subjectId: null,
        subjectLabel: `Setup Wizard Agent: refused policy_cannot_widen model:${SEEDED_MODEL}`,
      }),
    ]);
  });

  it('judges the agent a re-run updates with its stored policy (issue #535)', async () => {
    const first = await complete(setupInput());
    if (!first.ok) throw new Error(`setup failed: ${first.code}`);
    const before = await snapshot();
    // The agent setup will update keeps this stored policy, so its limit is judged too.
    const replaced = await db()
      .agents.forScope(scope())
      .replacePolicy(first.agentId, {
        engine: 'claude-agent-sdk',
        tools: {
          base: 'claude_code_preset',
          autoApprove: [],
          deny: [],
          permissionMode: 'default',
          allowDangerouslySkipPermissions: false,
        },
        skills: { mode: 'all' },
        limits: { maxTurns: 50, maxBudgetUsd: null },
      });
    expect(replaced.kind).toBe('updated');
    const live = db();
    await install(live, { policyCeiling: { limits: { maxTurns: 10 } } });
    try {
      expect(await complete(setupInput())).toMatchObject({
        ok: false,
        status: 403,
        code: 'policy_cannot_widen',
        message: expect.stringContaining('limits.maxTurns') as unknown,
      });
    } finally {
      await install(live);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('an administrator password that does not match persists nothing', async () => {
    const refused = await complete(setupInput({ adminPassword: 'not-the-one-time-password' }));
    expect(refused).toMatchObject({ ok: false, status: 401, code: 'invalid_credentials' });
    await expectUntouched();
  });

  it('a refusal after the provider test (no runtime) persists nothing either', async () => {
    const refused = await complete(setupInput({ runtime: 'docker' }));
    expect(refused).toMatchObject({ ok: false, status: 422, code: 'runtime_unavailable' });
    await expectUntouched();
  });

  it('a write refused part-way is rolled back, and a rollback step that fails is logged by label', async () => {
    // The workspace default is the last write but one: the connection, profile, agent and setup
    // mark have landed when it is refused. One undo step is made to fail as well.
    const live = db();
    const logged = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    await withFailingRoot(
      {
        setWorkspaceModelDefault: (workspaceId, value) =>
          value === null
            ? live.setWorkspaceModelDefault(workspaceId, null)
            : Promise.resolve(false),
        clearWorkspaceSetupAgentId: () => Promise.resolve(false),
      },
      async () => {
        expect(await complete(setupInput())).toMatchObject({
          ok: false,
          status: 500,
          code: 'workspace_default_reconciliation_failed',
        });
      },
    );
    // Deleting the agent the attempt created took its mark with it, so nothing remains.
    await expectUntouched();
    expect(logged.mock.calls).toEqual([
      [
        '[setup] rolling back a refused setup attempt left writes in place',
        { failed: [expect.stringMatching(/^clear setup mark on agent [0-9a-f-]{36}$/u)] },
      ],
    ]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(GOOD_KEY);
  });

  it('never overwrites a built-in agent that carries the name the wizard was given', async () => {
    const repository = db().agents.forScope(scope());
    const builder = await repository.create({
      name: 'builder',
      instructions: 'The shipped Builder.',
      modelConnectionId: null,
      model: null,
      runtimeProfileId: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      ownerPrincipalId: (await repository.list())[0]?.ownerPrincipalId ?? '',
      createdBy: adminUserId,
    });
    if (builder.kind !== 'created') throw new Error(`fixture agent: ${builder.kind}`);
    if (isolated === undefined) throw new Error('the isolated database is not open');
    await isolated.db
      .update(agents)
      .set({ builtinKey: 'builder' })
      .where(eq(agents.id, builder.agent.id));
    const before = await repository.get(builder.agent.id);

    expect(await complete(setupInput({ agentName: 'builder' }))).toMatchObject({
      ok: false,
      status: 409,
      code: 'name-conflict',
    });

    expect(await repository.get(builder.agent.id)).toEqual(before);
    expect(before?.builtin).toBe('builder');
  });

  it('a refused re-run gives the setup mark back to the agent that had it', async () => {
    const first = await complete(setupInput());
    if (!first.ok) throw new Error(`setup refused: ${first.code}`);
    // An agent the administrator made, which a re-run of the wizard then names.
    const repository = db().agents.forScope(scope());
    const general = (await repository.list()).find((agent) => agent.name === 'General');
    const other = await repository.create({
      name: 'Researcher',
      instructions: 'Research.',
      modelConnectionId: null,
      model: null,
      runtimeProfileId: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      ownerPrincipalId: general?.ownerPrincipalId ?? '',
      createdBy: adminUserId,
    });
    if (other.kind !== 'created') throw new Error(`fixture agent: ${other.kind}`);
    const before = await snapshot();

    // The re-run reads a broken default, so it must write one, and that write is refused.
    vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    await withFailingRoot(
      {
        getWorkspaceModelDefault: () =>
          Promise.resolve({ connectionId: crypto.randomUUID(), model: SEEDED_MODEL }),
        setWorkspaceModelDefault: () => Promise.resolve(false),
      },
      async () => {
        expect(await complete(setupInput({ agentName: 'Researcher' }))).toMatchObject({
          ok: false,
          code: 'workspace_default_reconciliation_failed',
        });
      },
    );
    expect(await db().getWorkspaceSetupAgentId(workspace.id)).toBe(first.agentId);
    expect(await snapshot()).toEqual(before);
    // The attempt's own mark on Researcher is taken back, not merely outranked.
    if (isolated === undefined) throw new Error('the isolated database is not open');
    const [researcher] = await isolated.db
      .select({ setupConfiguredAt: agents.setupConfiguredAt })
      .from(agents)
      .where(eq(agents.id, other.agent.id));
    expect(researcher).toEqual({ setupConfiguredAt: null });
  });

  it('a refused re-run with a new key keeps the old key, and restores the profile and agent', async () => {
    const first = await complete(setupInput());
    if (!first.ok) throw new Error(`setup refused: ${first.code}`);
    // What an administrator changed since: the profile's limits and the agent's instructions.
    const profiles = db().runtimeProfiles.forScope(scope());
    expect((await profiles.update(first.runtimeProfileId, { cpu: 2, memoryMb: 2048 })).kind).toBe(
      'updated',
    );
    const repository = db().agents.forScope(scope());
    expect((await repository.update(first.agentId, { instructions: 'Edited.' })).kind).toBe(
      'updated',
    );
    const before = await snapshot();
    const profileBefore = await profiles.get(first.runtimeProfileId);
    const agentBefore = await repository.get(first.agentId);

    // The setup mark is the late write that fails, after the key, profile and agent were written.
    await withFailingRoot({ setWorkspaceSetupAgentId: () => Promise.resolve(false) }, async () => {
      expect(
        await complete(setupInput({ providerApiKey: GOOD_KEY_2, agentInstructions: 'New.' })),
      ).toMatchObject({ ok: false, code: 'setup_agent_missing' });
    });
    expect(await snapshot()).toEqual(before);
    expect(before.connections[0]?.credential).toBe(GOOD_KEY);
    expect(await profiles.get(first.runtimeProfileId)).toMatchObject({
      cpu: 2,
      memoryMb: 2048,
      networkPolicy: profileBefore?.networkPolicy,
    });
    expect(await repository.get(first.agentId)).toMatchObject({
      instructions: 'Edited.',
      model: agentBefore?.model,
      modelConnectionId: agentBefore?.modelConnectionId,
    });
  });

  it('rotates the key on a re-run: the same connection, now with the new key', async () => {
    const first = await complete(setupInput());
    if (!first.ok) throw new Error(`setup refused: ${first.code}`);
    const second = await complete(setupInput({ providerApiKey: GOOD_KEY_2 }));
    if (!second.ok) throw new Error(`the re-run was refused: ${second.code}`);
    expect(second.modelConnectionId).toBe(first.modelConnectionId);
    const state = await snapshot();
    expect(state.connections).toEqual([
      { id: first.modelConnectionId, name: CONNECTION_NAME, ready: true, credential: GOOD_KEY_2 },
    ]);
    expect(state.workspaceDefault).toEqual({
      connectionId: first.modelConnectionId,
      model: SEEDED_MODEL,
    });
  });

  it('makes its runtime profile the workspace default, so a version naming no profile resolves to it', async () => {
    const references = {
      modelConnectionName: null,
      runtimeProfileName: null,
      skills: [],
      connectors: [],
      files: [],
    } as const;
    const versions = db().agentVersions.forScope(scope());
    // Before setup nothing is the default: an agent pushed now would have no runtime profile.
    await expect(versions.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'resolved',
      references: { runtimeProfileId: null },
    });

    const first = await complete(setupInput());
    if (!first.ok) throw new Error(`setup refused: ${first.code}`);
    await expect(
      db().runtimeProfiles.forScope(scope()).findWorkspaceDefault(),
    ).resolves.toMatchObject({ id: first.runtimeProfileId });
    await expect(versions.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'resolved',
      references: { runtimeProfileId: first.runtimeProfileId },
    });

    // A re-run keeps the one default.
    const again = await complete(setupInput());
    if (!again.ok) throw new Error(`the re-run was refused: ${again.code}`);
    await expect(
      db().runtimeProfiles.forScope(scope()).findWorkspaceDefault(),
    ).resolves.toMatchObject({ id: first.runtimeProfileId });
  });

  it('keeps a workspace default someone already chose', async () => {
    const profiles = db().runtimeProfiles.forScope(scope());
    const chosen = await profiles.ensureWorkspaceDefault(
      {
        name: 'chosen',
        driver: 'docker',
        runtimeConnectionId: null,
        cpu: null,
        memoryMb: null,
        diskMb: null,
        networkPolicy: 'none',
        allowedDomains: null,
        filesystem: 'read-only',
        persistPaths: null,
        timeoutSeconds: null,
        idleTimeoutSeconds: null,
        driverConfig: null,
      },
      { adoptable: () => true },
    );
    if (chosen.kind !== 'created') throw new Error(`expected created, got ${chosen.kind}`);
    const result = await complete(setupInput());
    if (!result.ok) throw new Error(`setup refused: ${result.code}`);
    expect(result.runtimeProfileId).not.toBe(chosen.profile.id);
    await expect(profiles.findWorkspaceDefault()).resolves.toMatchObject({ id: chosen.profile.id });
  });

  it.each(['name-conflict', 'not-adoptable'] as const)(
    'rolls every write back when the runtime profile cannot be made the default (%s)',
    async (kind) => {
      // The last write: the connection, profile, agent and setup mark have landed when it refuses.
      const live = db();
      await withFailingRoot(
        {
          runtimeProfiles: {
            forScope: (target) => {
              const repository = live.runtimeProfiles.forScope(target);
              return Object.assign(Object.create(repository) as typeof repository, {
                ensureWorkspaceDefault: async () => {
                  if (kind === 'name-conflict') return { kind, name: 'local default' };
                  const [profile] = await repository.list();
                  if (profile === undefined) throw new Error('setup wrote no runtime profile');
                  return { kind, profile };
                },
              });
            },
          },
        },
        async () => {
          expect(await complete(setupInput())).toMatchObject({
            ok: false,
            status: 409,
            code: kind,
          });
        },
      );
      await expectUntouched();
      await expect(
        db().runtimeProfiles.forScope(scope()).findWorkspaceDefault(),
      ).resolves.toBeNull();
    },
  );

  /**
   * Run setup, then create an agent the way `aw push` does (a version naming no runtime profile),
   * and answer a `push()` that saves and applies the next such version to `local`.
   */
  async function pushedAgentAfterSetup() {
    const setup = await complete(setupInput());
    if (!setup.ok) throw new Error(`setup refused: ${setup.code}`);
    const versions = db().agentVersions.forScope(scope());
    /** What an `aw push` whose version names no runtime profile materialises. */
    const pushed = async () => {
      const resolution = await versions.resolveDefinition({
        modelConnectionName: null,
        runtimeProfileName: null,
        skills: [],
        connectors: [],
        files: [],
      });
      if (resolution.kind !== 'resolved') throw new Error('the version did not resolve');
      return {
        name: 'Pushed',
        instructions: 'Answer briefly.',
        model: null,
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
        policy: null,
        references: resolution.references,
      };
    };
    const body = {
      definition: { agent: { name: 'Pushed', runtimeProfileName: null } },
      surfaces: [],
    };
    const created = await versions.createAgentWithFirstVersion({
      agent: {
        ...(await pushed()),
        ownerPrincipalId: workspace.principalId,
        createdBy: adminUserId,
      },
      version: {
        summary: 'first',
        via: 'aw-push',
        body,
        createdByPrincipalId: workspace.principalId,
      },
      environment: 'local',
    });
    if (created.kind !== 'created') throw new Error(`expected created, got ${created.kind}`);
    expect(created.agent.runtimeProfileId).toBe(setup.runtimeProfileId);
    const agentId = created.agent.id;

    const push = async () => {
      const next = await versions.create(agentId, {
        summary: 'next',
        via: 'aw-push',
        body,
        createdByPrincipalId: workspace.principalId,
      });
      if (next.kind !== 'created') throw new Error(`expected created, got ${next.kind}`);
      const applied = await versions.applyAndPoint(agentId, {
        environment: 'local',
        number: next.version.number,
        agent: await pushed(),
        reason: 'set',
        audit: {
          subjectLabel: `Pushed: local -> version ${String(next.version.number)}`,
          actorPrincipalId: workspace.principalId,
          actorUserId: adminUserId,
          actorLabel: 'Setup admin',
        },
      });
      if (applied.kind !== 'applied') throw new Error(`expected applied, got ${applied.kind}`);
      return applied.agent;
    };
    return { setup, agentId, push };
  }

  it('keeps the current runtime profile when a version naming none is applied after a console edit', async () => {
    const { setup, agentId, push } = await pushedAgentAfterSetup();

    // The console moves the agent to another profile (`PATCH /api/agents/:id`).
    const other = await db().runtimeProfiles.forScope(scope()).create({
      name: 'console choice',
      driver: 'docker',
      runtimeConnectionId: null,
      cpu: null,
      memoryMb: null,
      diskMb: null,
      networkPolicy: 'none',
      allowedDomains: null,
      filesystem: 'read-only',
      persistPaths: null,
      timeoutSeconds: null,
      idleTimeoutSeconds: null,
      driverConfig: null,
    });
    if (other.kind !== 'created') throw new Error(`expected created, got ${other.kind}`);
    const patched = await db()
      .agents.forScope(scope())
      .update(agentId, { runtimeProfileId: other.profile.id });
    if (patched.kind !== 'updated') throw new Error(`expected updated, got ${patched.kind}`);

    // The next push names no profile either: the console's choice stays, not the setup default.
    await expect(push()).resolves.toMatchObject({ runtimeProfileId: other.profile.id });
    await expect(db().agents.forScope(scope()).get(agentId)).resolves.toMatchObject({
      runtimeProfileId: other.profile.id,
    });
    await expect(
      db().runtimeProfiles.forScope(scope()).findWorkspaceDefault(),
    ).resolves.toMatchObject({ id: setup.runtimeProfileId });
  });

  it('gives an agent with no runtime profile the workspace default when a version naming none is applied', async () => {
    const { setup, agentId, push } = await pushedAgentAfterSetup();
    const cleared = await db().agents.forScope(scope()).update(agentId, { runtimeProfileId: null });
    if (cleared.kind !== 'updated') throw new Error(`expected updated, got ${cleared.kind}`);

    await expect(push()).resolves.toMatchObject({ runtimeProfileId: setup.runtimeProfileId });
    await expect(db().agents.forScope(scope()).get(agentId)).resolves.toMatchObject({
      runtimeProfileId: setup.runtimeProfileId,
    });
  });

  it('repairs its own row whose secret is gone, keeping the connection id', async () => {
    const first = await complete(setupInput());
    if (!first.ok) throw new Error(`setup refused: ${first.code}`);
    for (const secret of await secrets.list(scope())) await secrets.delete(scope(), secret.id);
    expect((await snapshot()).connections[0]).toMatchObject({ ready: false, credential: null });

    const repaired = await complete(setupInput({ providerApiKey: GOOD_KEY_2 }));
    if (!repaired.ok) throw new Error(`setup refused: ${repaired.code}`);
    expect(repaired.modelConnectionId).toBe(first.modelConnectionId);
    expect((await snapshot()).connections).toEqual([
      { id: first.modelConnectionId, name: CONNECTION_NAME, ready: true, credential: GOOD_KEY_2 },
    ]);
  });

  it('serialises the writes of two concurrent setups, even from two installed workflows', async () => {
    // Two installations stand for two replicas: separate in-process queues, one database lock.
    // Both create `anthropic default` on a fresh workspace; unserialised, one of them would be
    // refused with a name conflict and roll its rows back.
    const first = await install(db());
    const second = await install(db());
    const results = await Promise.all([
      first.complete(setupInput()),
      second.complete(setupInput({ providerApiKey: GOOD_KEY_2 })),
    ]);
    const accepted = results.map((result) => {
      if (!result.ok) throw new Error(`a concurrent setup was refused: ${result.code}`);
      return result;
    });
    expect(new Set(accepted.map((result) => result.modelConnectionId)).size).toBe(1);
    expect(new Set(accepted.map((result) => result.agentId)).size).toBe(1);
    const connectionId = await expectOneWorkingConnection(accepted[0]?.agentId ?? '', [
      GOOD_KEY,
      GOOD_KEY_2,
    ]);
    expect(connectionId).toBe(accepted[0]?.modelConnectionId);
    expect((await snapshot()).profiles).toEqual(['local default']);

    // And within one installation, two calls queue rather than overlap.
    const queued = await Promise.all([first.complete(setupInput()), first.complete(setupInput())]);
    expect(queued.every((result) => result.ok)).toBe(true);
    await expectOneWorkingConnection(accepted[0]?.agentId ?? '');
  });

  it('runs the provider checks before it takes the setup lock', async () => {
    // Another setup holds the lock; this one still probes the provider meanwhile.
    let release = (): void => undefined;
    const held = db().withWorkspaceSetupLock(
      workspace.id,
      1_000,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const probe = vi.mocked(probeModelConnection);
    const pending = complete(setupInput());
    await vi.waitFor(() => {
      expect(probe).toHaveBeenCalledTimes(1);
    });
    await expectUntouched();
    release();
    await held;
    const accepted = await pending;
    if (!accepted.ok) throw new Error(`setup refused: ${accepted.code}`);
    await expectOneWorkingConnection(accepted.agentId);
  });

  it('answers 409 setup_in_progress, writing nothing, when the lock stays held past the wait', async () => {
    let release = (): void => undefined;
    const held = db().withWorkspaceSetupLock(
      workspace.id,
      1_000,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      // Two setups through one installation: the second waits in the process's own queue behind
      // the first, which waits on the database lock; both give up at the same deadline.
      const impatient = await install(db(), { lockWaitMs: 300 });
      const started = Date.now();
      const results = await Promise.all([
        impatient.complete(setupInput()),
        impatient.complete(setupInput({ providerApiKey: GOOD_KEY_2 })),
      ]);
      expect(Date.now() - started).toBeLessThan(5_000);
      for (const result of results) {
        expect(result).toMatchObject({ ok: false, status: 409, code: 'setup_in_progress' });
      }
      await expectUntouched();
    } finally {
      release();
      await held;
      await install(db());
    }
  });

  it('answers 409 setup_conflict, writing nothing, when the connection changes during the checks', async () => {
    const first = await complete(setupInput());
    if (!first.ok) throw new Error(`setup refused: ${first.code}`);
    const store = models.forWorkspace(workspace.id);
    // While this re-run probes the provider, the setup connection is pointed somewhere else.
    vi.mocked(probeModelConnection).mockImplementationOnce(async () => {
      const changed = await store.update(first.modelConnectionId, {
        config: { baseUrl: 'https://anthropic-proxy.example.test' },
      });
      if (changed.kind !== 'updated') throw new Error(`fixture update: ${changed.kind}`);
      return { ok: true, status: 200, latencyMs: 1, message: 'Connection succeeded.' };
    });
    const before = await snapshot();
    const refused = await complete(
      setupInput({ providerApiKey: GOOD_KEY_2, agentInstructions: 'Changed.' }),
    );
    expect(refused).toMatchObject({ ok: false, status: 409, code: 'setup_conflict' });
    // Only the administrator's config change landed: the key, rows and default are as they were.
    expect(await snapshot()).toEqual(before);
    expect(before.connections[0]?.credential).toBe(GOOD_KEY);
    expect((await store.get(first.modelConnectionId))?.config).toEqual({
      baseUrl: 'https://anthropic-proxy.example.test',
    });
    const agent = await db().agents.forScope(scope()).get(first.agentId);
    expect(agent?.instructions).toBe('Answer briefly.');
  });

  it('answers 422 runtime_test_timeout, writing nothing, when the runtime test never settles', async () => {
    configureWebRuntimeRegistry({ ...LOCAL_REGISTRY, test: () => new Promise(() => undefined) });
    try {
      const impatient = await install(db(), { runtimeTestTimeoutMs: 100 });
      const refused = await impatient.complete(setupInput());
      expect(refused).toMatchObject({ ok: false, status: 422, code: 'runtime_test_timeout' });
      await expectUntouched();
    } finally {
      configureWebRuntimeRegistry(LOCAL_REGISTRY);
      await install(db());
    }
  });

  it('answers 422 runtime_connection_missing, writing nothing, for a provider driver with no connection', async () => {
    configureWebRuntimeRegistry({
      ...LOCAL_REGISTRY,
      test: () =>
        Promise.reject(
          new DomainError({
            category: 'validation',
            code: 'runtime_connection_missing',
            publicMessage: 'Create an external runtime connection.',
          }),
        ),
    });
    try {
      await install(db());
      const refused = await complete(setupInput());
      expect(refused).toEqual({
        ok: false,
        status: 422,
        code: 'runtime_connection_missing',
        message: 'Create an external runtime connection.',
      });
      await expectUntouched();
    } finally {
      configureWebRuntimeRegistry(LOCAL_REGISTRY);
      await install(db());
    }
  });

  it("tests the runtime in the signed-in admin's workspace, taken from the session", async () => {
    const scopes: unknown[] = [];
    configureWebRuntimeRegistry({
      ...LOCAL_REGISTRY,
      test: (driverId, _echo, testScope) => {
        scopes.push(testScope);
        return Promise.resolve({ driverId, transcript: [], destroyed: true });
      },
    });
    try {
      await install(db());
      const result = await complete(setupInput());
      expect(result.ok).toBe(true);
      expect(scopes).toEqual([{ workspaceId: workspace.id }]);
    } finally {
      configureWebRuntimeRegistry(LOCAL_REGISTRY);
      await install(db());
    }
  });

  it('never overwrites a stored key it cannot decrypt, and says to check the master key', async () => {
    const first = await complete(setupInput());
    if (!first.ok) throw new Error(`setup refused: ${first.code}`);
    const before = await snapshot();
    const logged = captureLog();
    decryption.fails = true;
    const refused = await complete(setupInput({ providerApiKey: GOOD_KEY_2 }));
    expect(refused).toMatchObject({ ok: false, status: 500, code: 'credential_unreadable' });
    if (refused.ok) throw new Error('unreachable');
    expect(refused.message).toContain('MASTER_ENCRYPTION_KEY');
    const messages = logged.text();
    expect(messages).toContain('DecryptError');
    expect(messages).not.toContain(GOOD_KEY);
    // With the right master key back, the original key is still there.
    decryption.fails = false;
    expect(await snapshot()).toEqual(before);
    expect(before.connections[0]?.credential).toBe(GOOD_KEY);
  });

  it('a refused attempt then an accepted one leaves exactly one working connection used everywhere', async () => {
    expect(await complete(setupInput({ providerApiKey: BAD_KEY }))).toMatchObject({
      ok: false,
      code: 'provider_test_failed',
    });
    const accepted = await complete(setupInput());
    if (!accepted.ok) throw new Error(`setup refused: ${accepted.code}`);
    const connectionId = await expectOneWorkingConnection(accepted.agentId);
    expect(accepted.modelConnectionId).toBe(connectionId);

    // A later refused attempt does not touch the working state, and a re-run is idempotent.
    await complete(setupInput({ providerApiKey: BAD_KEY }));
    expect(await expectOneWorkingConnection(accepted.agentId)).toBe(connectionId);
    const again = await complete(setupInput());
    if (!again.ok) throw new Error(`the re-run was refused: ${again.code}`);
    expect(again.agentId).toBe(accepted.agentId);
    expect(await expectOneWorkingConnection(again.agentId)).toBe(connectionId);
  });

  it('repairs the connection a refused 0.2.0 attempt left: the key is replaced, not duplicated', async () => {
    // What a refused setup on 0.2.0 left behind: `anthropic default`, ready, with the rejected key.
    const store = models.forWorkspace(workspace.id);
    const stale = await store.create({
      name: CONNECTION_NAME,
      provider: 'anthropic',
      apiKey: BAD_KEY,
      config: {},
    });
    if (stale.kind !== 'created') throw new Error(`stale connection: ${stale.kind}`);
    // And, as a later administrator action might have, the default and General pointing at it.
    await db().setWorkspaceModelDefault(workspace.id, {
      connectionId: stale.connection.id,
      model: SEEDED_MODEL,
    });
    await db().agents.forScope(scope()).update(workspace.generalAgentId, {
      modelConnectionId: stale.connection.id,
      model: SEEDED_MODEL,
    });

    const accepted = await complete(setupInput());
    if (!accepted.ok) throw new Error(`setup refused: ${accepted.code}`);
    expect(accepted.modelConnectionId).toBe(stale.connection.id);
    expect(await expectOneWorkingConnection(accepted.agentId)).toBe(stale.connection.id);
  });

  describe('a default driver that needs a provider key (issue #827)', () => {
    const EXTERNAL = {
      runtime: 'external',
      runtimeCredential: E2B_KEY,
      runtimeEndpoint: E2B_ENDPOINT,
    };
    /** The keys the registry was asked to test with; like the real one it refuses without a key. */
    const testedWith: (string | undefined)[] = [];

    function useExternalRegistry(): void {
      testedWith.length = 0;
      configureWebRuntimeRegistry({
        list: () =>
          Promise.resolve([
            {
              id: 'external',
              label: 'External provider',
              connectionExists: true,
              imageReachable: true,
              testPassed: true,
              state: 'enabled',
              reason: null,
              networkPolicies: null,
            },
          ]),
        test: (driverId, _echo, testScope) => {
          testedWith.push(testScope?.providerCredential);
          if (testScope?.providerCredential === undefined) {
            return Promise.reject(
              new DomainError({
                category: 'validation',
                code: 'runtime_connection_missing',
                publicMessage:
                  'runtime_connection_missing: Test Runtime of driver external needs a runtime connection.',
              }),
            );
          }
          return Promise.resolve({ driverId, transcript: [], destroyed: true });
        },
      });
    }

    async function runtimeConnectionNames(): Promise<readonly string[]> {
      return (await runtimeSecrets.list(scope()))
        .map((secret) => secret.name)
        .filter((name) => name.startsWith('RUNTIME_CONNECTION__'));
    }

    async function storedKey(connectionId: string): Promise<string | null> {
      const outcome = await resolveRuntimeConnectionCredential(
        { secrets: runtimeSecrets, scopes: db().scopes },
        workspace.id,
        connectionId,
        'external',
      );
      return outcome.kind === 'resolved' ? outcome.credential : null;
    }

    beforeEach(useExternalRegistry);
    afterEach(async () => {
      configureWebRuntimeRegistry(LOCAL_REGISTRY);
      await install(db());
    });

    it('tests with the submitted key, stores it as an encrypted runtime connection, and points the profile at it', async () => {
      const spies = captureLog();
      const result = await complete(setupInput(EXTERNAL));
      if (!result.ok) throw new Error(`setup refused: ${result.code}`);
      expect(testedWith).toEqual([E2B_KEY]);
      if (result.runtimeConnectionId === null) throw new Error('no runtime connection was stored');
      expect(await runtimeConnectionNames()).toEqual([
        'RUNTIME_CONNECTION__EXTERNAL__EXTERNAL_DEFAULT',
      ]);
      expect(await storedKey(result.runtimeConnectionId)).toBe(E2B_KEY);
      const profile = await db().runtimeProfiles.forScope(scope()).get(result.runtimeProfileId);
      expect(profile).toMatchObject({
        name: 'external default',
        driver: 'external',
        runtimeConnectionId: result.runtimeConnectionId,
      });
      expect(JSON.stringify(result)).not.toContain(E2B_KEY);
      expect(spies.text()).not.toContain(E2B_KEY);
    });

    it('answers 500 setup_failed naming the runtime test, and stores nothing, when the test throws', async () => {
      const spy = captureLog();
      configureWebRuntimeRegistry({
        ...LOCAL_REGISTRY,
        list: () =>
          LOCAL_REGISTRY.list().then((entries) =>
            entries.map((entry) => ({ ...entry, id: 'external' })),
          ),
        test: () => Promise.reject(new Error(`provider refused ${E2B_KEY} at https://api.e2b.dev`)),
      });
      const refused = await complete(setupInput(EXTERNAL));
      expect(refused).toMatchObject({ ok: false, status: 500, code: 'setup_failed' });
      if (refused.ok) throw new Error('unreachable');
      expect(refused.message).toContain('runtime test');
      expect(refused.message).not.toContain(E2B_KEY);
      const logged = spy.text();
      expect(logged).toContain('runtime test');
      expect(logged).not.toContain(E2B_KEY);
      expect(logged).not.toContain('api.e2b.dev');
      await expectUntouched();
      expect(await runtimeConnectionNames()).toEqual([]);
    });

    it('names the manager status, typed code and Worker step, and nothing from its body, when the manager refuses the runtime test', async () => {
      vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
      configureWebRuntimeRegistry({
        ...LOCAL_REGISTRY,
        list: () =>
          LOCAL_REGISTRY.list().then((entries) =>
            entries.map((entry) => ({ ...entry, id: 'external' })),
          ),
        test: async () => {
          const client = createRuntimeManagerClient('https://manager.example', 'm'.repeat(32), () =>
            Promise.resolve(
              Response.json(
                {
                  error: {
                    code: 'worker_exception',
                    step: 'forward',
                    message: `refused ${E2B_KEY} at https://api.e2b.dev`,
                  },
                },
                { status: 502 },
              ),
            ),
          );
          await client.verify(
            { sessionId: 's', workspacePath: '/workspace', engine: 'claude-agent-sdk' },
            'external',
            E2B_KEY,
          );
          throw new Error('unreachable');
        },
      });
      const refused = await complete(setupInput(EXTERNAL));
      expect(refused).toMatchObject({ ok: false, status: 500, code: 'setup_failed' });
      if (refused.ok) throw new Error('unreachable');
      expect(refused.message).toBe(
        'Setup failed at the runtime test step (RuntimeManagerError: runner manager answered HTTP 502 worker_exception at forward). See the server log, then retry.',
      );
      await expectUntouched();
    });

    it("names the invalid field's typed code when the manager answers 400", async () => {
      vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
      configureWebRuntimeRegistry({
        ...LOCAL_REGISTRY,
        list: () =>
          LOCAL_REGISTRY.list().then((entries) =>
            entries.map((entry) => ({ ...entry, id: 'external' })),
          ),
        test: async () => {
          const client = createRuntimeManagerClient('https://manager.example', 'm'.repeat(32), () =>
            Promise.resolve(
              Response.json(
                { error: 'invalid_engine', message: 'engine must be a safe path segment' },
                { status: 400 },
              ),
            ),
          );
          await client.verify(
            { sessionId: 's', workspacePath: '/workspace', engine: '' },
            'external',
            E2B_KEY,
          );
          throw new Error('unreachable');
        },
      });
      const refused = await complete(setupInput(EXTERNAL));
      if (refused.ok) throw new Error('unreachable');
      expect(refused.message).toBe(
        'Setup failed at the runtime test step (RuntimeManagerError: runner manager answered HTTP 400 invalid_engine). See the server log, then retry.',
      );
      await expectUntouched();
    });

    describe('a manager Worker whose container is still starting', () => {
      const starting = () => new Response('The runner manager is starting', { status: 503 });
      const verified = () =>
        Response.json({
          fingerprint: 'verified-fingerprint',
          verifiedAt: '2026-09-11T00:00:00.000Z',
          expiresAt: '2026-09-12T00:00:00.000Z',
        });

      /** The real client over a manager that answers `answers` in order, then repeats the last. */
      function useManager(answers: readonly (() => Response)[]): { calls: () => number } {
        let calls = 0;
        configureWebRuntimeRegistry({
          ...LOCAL_REGISTRY,
          list: () =>
            LOCAL_REGISTRY.list().then((entries) =>
              entries.map((entry) => ({ ...entry, id: 'external' })),
            ),
          test: async (driverId) => {
            const client = createRuntimeManagerClient(
              'https://manager.example',
              'm'.repeat(32),
              () => {
                const answer = answers[Math.min(calls, answers.length - 1)];
                calls += 1;
                if (answer === undefined) throw new Error('no manager answer');
                return Promise.resolve(answer());
              },
              { notReadyRetry: { windowMs: 200, initialDelayMs: 5 } },
            );
            await client.verify(
              { sessionId: 's', workspacePath: '/workspace', engine: 'claude-agent-sdk' },
              'external',
              E2B_KEY,
            );
            return { driverId, transcript: [], destroyed: true };
          },
        });
        return { calls: () => calls };
      }

      it('completes setup once the manager answers the retried runtime test', async () => {
        const manager = useManager([starting, starting, verified]);
        const result = await complete(setupInput(EXTERNAL));
        expect(result.ok).toBe(true);
        expect(manager.calls()).toBe(3);
      });

      it('fails setup at the runtime test step with the typed hop, and stores nothing, when it never starts', async () => {
        vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
        const manager = useManager([starting]);
        const refused = await complete(setupInput(EXTERNAL));
        expect(refused).toMatchObject({ ok: false, status: 500, code: 'setup_failed' });
        if (refused.ok) throw new Error('unreachable');
        expect(refused.message).toBe(
          'Setup failed at the runtime test step (RuntimeManagerError: runner manager answered HTTP 503 manager_not_ready). See the server log, then retry.',
        );
        expect(manager.calls()).toBeGreaterThan(1);
        await expectUntouched();
      });
    });

    describe('a runtime that refuses every network policy (ADR-0131)', () => {
      const CLOUDFLARE = { ...EXTERNAL, runtime: 'cloudflare-sandbox' };

      /** The manager's answer for `cloudflare-sandbox`: every policy refused by name. */
      function useRefusingRegistry(): void {
        configureWebRuntimeRegistry({
          ...LOCAL_REGISTRY,
          list: () =>
            LOCAL_REGISTRY.list().then((entries) =>
              entries.map((entry) => ({ ...entry, id: 'cloudflare-sandbox' })),
            ),
          test: async () => {
            const client = createRuntimeManagerClient(
              'https://manager.example',
              'm'.repeat(32),
              () =>
                Promise.resolve(
                  Response.json(
                    {
                      error: 'network_policy_unsupported',
                      message: 'external runtime: provider cloudflare-sandbox refuses the none',
                    },
                    { status: 422 },
                  ),
                ),
            );
            await client.verify(
              { sessionId: 's', workspacePath: '/workspace', engine: 'claude-agent-sdk' },
              'cloudflare-sandbox',
              E2B_KEY,
            );
            throw new Error('unreachable');
          },
        });
      }

      it('completes setup and records the refusal instead of failing', async () => {
        useRefusingRegistry();
        const result = await complete(setupInput(CLOUDFLARE));
        if (!result.ok) throw new Error(`setup refused: ${result.code}`);
        expect(result.runtimeRefusal).toEqual({
          code: 'network_policy_unsupported',
          message:
            'cloudflare-sandbox refuses every network policy (ADR-0131): runs are refused with network_policy_unsupported until a policy is declared.',
        });
        const profile = await db().runtimeProfiles.forScope(scope()).get(result.runtimeProfileId);
        expect(profile).toMatchObject({ driver: 'cloudflare-sandbox' });
        expect(JSON.stringify(result)).not.toContain(E2B_KEY);
      });

      it('still rolls everything back when a write throws after the refusal', async () => {
        vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
        useRefusingRegistry();
        await withFailingRoot(
          { setWorkspaceSetupAgentId: () => Promise.reject(new Error('connection terminated')) },
          async () => {
            expect(await complete(setupInput(CLOUDFLARE))).toMatchObject({
              ok: false,
              status: 500,
              code: 'setup_failed',
            });
          },
        );
        await expectUntouched();
        expect(await runtimeConnectionNames()).toEqual([]);
      });
    });

    it('answers 503 setup_unavailable naming the secrets store, and writes nothing, when the store throws', async () => {
      const spy = captureLog();
      const broken: SecretsService = Object.assign(
        Object.create(runtimeSecrets) as SecretsService,
        {
          list: () => Promise.reject(new Error(`store unreachable for ${E2B_KEY}`)),
        },
      );
      await install(db(), { runtimeSecrets: broken });
      const refused = await complete(setupInput(EXTERNAL));
      expect(refused).toMatchObject({ ok: false, status: 503, code: 'setup_unavailable' });
      if (refused.ok) throw new Error('unreachable');
      expect(refused.message).toContain('secrets store');
      expect(refused.message).not.toContain(E2B_KEY);
      expect(spy.text()).not.toContain(E2B_KEY);
      await expectUntouched();
      expect(await runtimeConnectionNames()).toEqual([]);
    });

    it('answers 500 setup_failed naming persistence, and rolls back, when a write throws', async () => {
      vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
      await withFailingRoot(
        { setWorkspaceSetupAgentId: () => Promise.reject(new Error('connection terminated')) },
        async () => {
          const refused = await complete(setupInput(EXTERNAL));
          expect(refused).toMatchObject({ ok: false, status: 500, code: 'setup_failed' });
          if (refused.ok) throw new Error('unreachable');
          expect(refused.message).toContain('persistence');
        },
      );
      await expectUntouched();
      expect(await runtimeConnectionNames()).toEqual([]);
    });

    it('rolls the runtime connection back with the rest of a refused setup', async () => {
      vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
      await withFailingRoot(
        { setWorkspaceSetupAgentId: () => Promise.resolve(false) },
        async () => {
          expect(await complete(setupInput(EXTERNAL))).toMatchObject({
            ok: false,
            code: 'setup_agent_missing',
          });
        },
      );
      await expectUntouched();
      expect(await runtimeConnectionNames()).toEqual([]);
    });

    it('a retry rotates the same connection, and a refused retry puts the old key back', async () => {
      const first = await complete(setupInput(EXTERNAL));
      if (!first.ok || first.runtimeConnectionId === null) throw new Error('first setup failed');
      const connectionId = first.runtimeConnectionId;
      vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
      await withFailingRoot(
        { setWorkspaceSetupAgentId: () => Promise.resolve(false) },
        async () => {
          expect(
            await complete(setupInput({ ...EXTERNAL, runtimeCredential: E2B_KEY_2 })),
          ).toMatchObject({ ok: false, code: 'setup_agent_missing' });
        },
      );
      expect(await storedKey(connectionId)).toBe(E2B_KEY);
      const profile = await db().runtimeProfiles.forScope(scope()).get(first.runtimeProfileId);
      expect(profile?.runtimeConnectionId).toBe(connectionId);

      const rotated = await complete(setupInput({ ...EXTERNAL, runtimeCredential: E2B_KEY_2 }));
      if (!rotated.ok) throw new Error(`setup refused: ${rotated.code}`);
      expect(rotated.runtimeConnectionId).toBe(connectionId);
      expect(await storedKey(connectionId)).toBe(E2B_KEY_2);
      expect(await runtimeConnectionNames()).toHaveLength(1);
    });

    it('refuses a key for a driver that takes none, before testing or writing anything', async () => {
      const refused = await complete(setupInput({ ...EXTERNAL, runtime: 'local' }));
      expect(refused).toMatchObject({ ok: false, status: 400, code: 'invalid_setup' });
      expect(testedWith).toEqual([]);
      await expectUntouched();
      expect(await runtimeConnectionNames()).toEqual([]);
    });

    it('still answers 422 runtime_connection_missing without a key, naming the setup fields', async () => {
      const refused = await complete(setupInput({ runtime: 'external' }));
      expect(refused).toMatchObject({ ok: false, status: 422, code: 'runtime_connection_missing' });
      if (refused.ok) throw new Error('unreachable');
      expect(refused.message).toContain('runtimeCredential');
      await expectUntouched();
    });

    it('answers 503 setup_unavailable when encrypted runtime storage is unavailable, before any check', async () => {
      await install(db(), { runtimeSecrets: null });
      const refused = await complete(setupInput(EXTERNAL));
      expect(refused).toMatchObject({ ok: false, status: 503, code: 'setup_unavailable' });
      expect(testedWith).toEqual([]);
      await expectUntouched();
    });

    it('never overwrites a stored key it cannot read, and names no key in the refusal', async () => {
      if (isolated === undefined) throw new Error('the isolated database is not open');
      const otherMasterKey = await createSecretsService({
        MASTER_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
        DATABASE_URL: isolated.url,
      });
      try {
        const name = 'RUNTIME_CONNECTION__EXTERNAL__EXTERNAL_DEFAULT';
        const sealed = JSON.stringify({ endpoint: E2B_ENDPOINT, credential: E2B_KEY_2 });
        const seeded = await otherMasterKey.create(scope(), {
          name,
          value: Buffer.from(sealed, 'utf8'),
        });
        if (seeded.kind !== 'created') throw new Error('the unreadable key was not seeded');

        const refused = await complete(setupInput(EXTERNAL));
        expect(refused).toMatchObject({ ok: false, status: 500, code: 'credential_unreadable' });
        if (refused.ok) throw new Error('unreachable');
        expect(refused.message).not.toContain(E2B_KEY);
        expect(refused.message).not.toContain(E2B_KEY_2);
        expect((await otherMasterKey.resolveByName(scope(), name))?.value.toString('utf8')).toBe(
          sealed,
        );
        await expectUntouched();
        expect(await runtimeConnectionNames()).toEqual([name]);
      } finally {
        await otherMasterKey.close();
      }
    });

    it('answers 409 when the runtime connection cannot be created, writing nothing', async () => {
      const conflicting: SecretsService = Object.assign(
        Object.create(runtimeSecrets) as SecretsService,
        {
          create: (_scope: WorkspaceScope, input: { readonly name: string }) =>
            Promise.resolve({ kind: 'name-conflict' as const, name: input.name }),
        },
      );
      await install(db(), { runtimeSecrets: conflicting });
      vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
      const refused = await complete(setupInput(EXTERNAL));
      expect(refused).toMatchObject({ ok: false, status: 409, code: 'name-conflict' });
      await expectUntouched();
      expect(await runtimeConnectionNames()).toEqual([]);
    });

    it('answers 500 when a retry cannot rotate the stored key, keeping the old one', async () => {
      const first = await complete(setupInput(EXTERNAL));
      if (!first.ok || first.runtimeConnectionId === null) throw new Error('first setup failed');
      const vanishing: SecretsService = Object.assign(
        Object.create(runtimeSecrets) as SecretsService,
        { replace: () => Promise.resolve({ kind: 'not-found' as const }) },
      );
      await install(db(), { runtimeSecrets: vanishing });
      vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
      const refused = await complete(setupInput({ ...EXTERNAL, runtimeCredential: E2B_KEY_2 }));
      expect(refused).toMatchObject({
        ok: false,
        status: 500,
        code: 'runtime_connection_unavailable',
      });
      if (refused.ok) throw new Error('unreachable');
      expect(refused.message).not.toContain(E2B_KEY_2);
      expect(await storedKey(first.runtimeConnectionId)).toBe(E2B_KEY);
    });

    it('refuses a wrong administrator password before it looks at the key', async () => {
      const refused = await complete(setupInput({ ...EXTERNAL, adminPassword: 'wrong password' }));
      expect(refused).toMatchObject({ ok: false, status: 401 });
      expect(testedWith).toEqual([]);
      expect(await runtimeConnectionNames()).toEqual([]);
    });
  });
});
