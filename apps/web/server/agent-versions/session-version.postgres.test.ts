/**
 * A conversation runs the version it started with (issue #612), on PostgreSQL through the real
 * composition root: `register()`'s `openSession` pins the version `local` points at into
 * `sessions.agent_version_id`, a later `aw push` (a new version, then `local` moved onto it) leaves
 * that pin alone, and the run configuration read for the pinned session is the old version's
 * while the agent row already says the new one. A legacy agent with no pointer starts unpinned.
 * A follow-up's run-start preflight and a public share's runs read the pinned version too.
 */
import crypto from 'node:crypto';

import { openDatabaseRoot, type DatabaseRoot, type WorkspaceScope } from '@agent-workspace/core/db';
import {
  closeIsolatedTestResources,
  createDatabaseAgentRepositoryProvider,
  createDatabaseAgentResourceRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  runtimeProfiles,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRepositoryAgentResourceStoreProvider } from '../agents/resource-store';
import { createRepositoryAgentStoreProvider } from '../agents/store';
import type { RegisteredComposition } from '../composition/register';
import { getRunApi, type LaunchContext } from '../runs/environment';
import { FIXTURE_PERMISSIONS, FIXTURE_POLICY, versionRequest, type FixtureEdits } from './fixtures';
import { createAgentVersion } from './handlers';
import { setAgentPointer } from './pointers';
import { createRunAgentReader } from './session-version';
import { applicationContext } from '../application-context';
import { installTestRunApi } from '../application-context-fixtures';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
const CONTROLLED_ENV = ['DATABASE_URL', 'SESSION_SECRET', 'RUNNER_URL', 'NEXT_RUNTIME'] as const;

describe.skipIf(!hasDatabase)('a session runs the version it started with (PostgreSQL)', () => {
  let isolated: IsolatedTestDatabase;
  let root: DatabaseRoot;
  let composition: RegisteredComposition;
  let scope: WorkspaceScope;
  let previousEnv: Record<(typeof CONTROLLED_ENV)[number], string | undefined>;
  const workspaceId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const profileName = 'Pinned profile';
  const principal = {
    principalId,
    ownerPrincipalId: principalId,
    userId: ownerId,
    workspaceId,
    role: 'owner' as const,
    scope: null,
  };

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_session_version_pin');
    const membershipId = crypto.randomUUID();
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: workspaceId, name: 'Pins' });
    await isolated.db
      .insert(users)
      .values({ id: ownerId, email: `${ownerId}@example.com`, name: 'Owner' });
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipId, workspaceId, userId: ownerId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    await isolated.db.insert(runtimeProfiles).values({
      id: crypto.randomUUID(),
      workspaceId,
      name: profileName,
      driver: 'local',
      networkPolicy: 'none',
      filesystem: 'read-write',
    });
    root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
    const resolved = await root.scopes.forWorkspaceId(workspaceId);
    if (resolved === null) throw new Error('scope resolution failed');
    scope = resolved;
    previousEnv = Object.fromEntries(
      CONTROLLED_ENV.map((key) => [key, process.env[key]]),
    ) as typeof previousEnv;
    process.env['DATABASE_URL'] = isolated.url;
    process.env['SESSION_SECRET'] = 'session-version-pin-session-secret-at-least-32-bytes';
    process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
    delete process.env['NEXT_RUNTIME'];
    const { register } = await import('../composition/register');
    const registered = await register();
    if (registered === undefined) throw new Error('register returned no composition');
    composition = registered;
  }, 180_000);

  afterAll(async () => {
    for (const key of CONTROLLED_ENV) {
      const prior = previousEnv[key];
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    await closeIsolatedTestResources(isolated, composition, root);
  });

  async function createAgent(name: string): Promise<string> {
    const created = await root.agents.forScope(scope).create({
      name,
      instructions: 'Before any version.',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
      createdBy: ownerId,
      ownerPrincipalId: principalId,
    });
    if (created.kind !== 'created') throw new Error(`agent seed failed: ${created.kind}`);
    return created.agent.id;
  }

  /** `aw push`: save the next version, then move `local` onto it. Answers the version's id. */
  async function push(
    agentId: string,
    number: number,
    instructions: string,
    edits: FixtureEdits = {},
  ): Promise<string> {
    const store = await applicationContext()?.agentVersions.versions.forWorkspace(workspaceId);
    const row = await root.agents.forScope(scope).get(agentId);
    if (store === undefined || store === null || row === null) throw new Error('wired');
    const saved = await createAgentVersion(
      versionRequest({ ...edits, name: row.name, instructions }),
      row,
      principalId,
      { store },
    );
    expect(saved.status).toBe(201);
    const moved = await setAgentPointer(
      { environment: 'local', version: number },
      row,
      { principalId, userId: ownerId, actor: 'owner' },
      { store },
    );
    expect(moved.status).toBe(200);
    const record = await store.find(agentId, number);
    if (record === null) throw new Error(`version ${String(number)} was saved`);
    return record.id;
  }

  /**
   * Push version `number`, naming no runtime profile, and detach the row's profile as the console
   * can: such a push keeps the profile the row has (#832), so the row needs both to have none.
   */
  async function pushWithoutProfile(agentId: string, number: number): Promise<void> {
    await push(agentId, number, `Version ${String(number)}.`);
    const detached = await root.agents.forScope(scope).update(agentId, { runtimeProfileId: null });
    expect(detached.kind).toBe('updated');
  }

  function api() {
    const installed = getRunApi();
    if (installed === null) throw new Error('run API was not installed');
    return installed;
  }

  it('pins local at start, keeps the pin after a push, and reads the pinned version to run', async () => {
    const agentId = await createAgent('Pinned');
    const agent = { id: agentId, workspaceId, engine: 'claude-agent-sdk' };
    const v1 = await push(agentId, 1, 'Version one.');

    const started = await api().openSession(principal, agent, null);
    expect(started).toMatchObject({ agentVersionId: v1, versionEngine: 'claude-agent-sdk' });
    if (started === null) throw new Error('the session opened');
    expect((await root.sessions.forScope(scope).get(started.id))?.agentVersionId).toBe(v1);

    const v2 = await push(agentId, 2, 'Version two.');
    expect((await root.agents.forScope(scope).get(agentId))?.instructions).toBe('Version two.');
    expect(await api().openSession(principal, agent, started.id)).toMatchObject({
      agentVersionId: v1,
    });
    expect(await api().openSession(principal, agent, null)).toMatchObject({ agentVersionId: v2 });

    const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
    const read = createRunAgentReader({
      agents: createRepositoryAgentStoreProvider({
        repositories: createDatabaseAgentRepositoryProvider(isolated.db),
        scopes,
      }),
      assignments: createRepositoryAgentResourceStoreProvider({
        repositories: createDatabaseAgentResourceRepositoryProvider(isolated.db),
        scopes,
      }),
      versions: () => Promise.resolve(root.agentVersions.forScope(scope)),
    });
    expect((await read(workspaceId, agentId, v1)).agent.instructions).toBe('Version one.');
    expect((await read(workspaceId, agentId, null)).agent.instructions).toBe('Version two.');
  }, 60_000);

  it('starts a legacy agent’s session unpinned instead of refusing no_pointer', async () => {
    const agentId = await createAgent('Legacy');
    const started = await api().openSession(
      principal,
      { id: agentId, workspaceId, engine: 'claude-agent-sdk' },
      null,
    );
    expect(started).toMatchObject({ agentVersionId: null });
    expect(started).not.toHaveProperty('versionEngine');
    if (started === null) throw new Error('the session opened');
    expect((await root.sessions.forScope(scope).get(started.id))?.agentVersionId).toBeNull();
  }, 60_000);

  it('checks a follow-up against its pinned version, not the row a push moved', async () => {
    const agentId = await createAgent('Preflight');
    const agent = { id: agentId, workspaceId, engine: 'claude-agent-sdk' };
    await push(agentId, 1, 'Version one.', { runtimeProfileName: profileName });
    const started = await api().openSession(principal, agent, null);
    if (started === null) throw new Error('the session opened');
    await pushWithoutProfile(agentId, 2);
    const { preflight } = api();
    if (preflight === undefined) throw new Error('the run API installs a preflight');

    // The row (v2) has no runtime profile, so a new conversation is refused for it ...
    expect(await preflight(principal, agent, null, null)).toMatchObject({
      code: 'agent_runtime_profile_missing',
    });
    // ... but the v1 conversation's next turn is checked against v1, which has one.
    expect((await preflight(principal, agent, started.id, null))?.code).not.toBe(
      'agent_runtime_profile_missing',
    );
  }, 60_000);

  it('pins a new session to a requested version, and checks it against that version (#618)', async () => {
    const agentId = await createAgent('Evaluated');
    const agent = { id: agentId, workspaceId, engine: 'claude-agent-sdk' };
    const v1 = await push(agentId, 1, 'Version one.', { runtimeProfileName: profileName });
    await pushWithoutProfile(agentId, 2);
    const { preflight } = api();
    if (preflight === undefined) throw new Error('the run API installs a preflight');

    // `local` is v2, which has no runtime profile; asking for v1 checks and pins v1 instead.
    expect(await preflight(principal, agent, null, null)).toMatchObject({
      code: 'agent_runtime_profile_missing',
    });
    expect((await preflight(principal, agent, null, null, v1))?.code).not.toBe(
      'agent_runtime_profile_missing',
    );
    const started = await api().openSession(principal, agent, null, v1);
    expect(started).toMatchObject({ agentVersionId: v1 });
    if (started === null) throw new Error('the session opened');
    expect((await root.sessions.forScope(scope).get(started.id))?.agentVersionId).toBe(v1);
  }, 60_000);

  it('finds a follow-up’s agent on its pinned version’s engine after a push moved the row', async () => {
    const agentId = await createAgent('Engine');
    const agent = { id: agentId, workspaceId, engine: 'claude-agent-sdk' };
    await push(agentId, 1, 'Version one.');
    const started = await api().openSession(principal, agent, null);
    if (started === null) throw new Error('the session opened');
    await push(agentId, 2, 'Version two.', {
      policy: { engine: 'pi', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits },
    });

    expect((await api().findAgent(principal, agentId))?.engine).toBe('pi');
    expect((await api().findAgent(principal, agentId, started.id))?.engine).toBe(
      'claude-agent-sdk',
    );
  }, 60_000);

  it('pins a share visitor’s session and keeps running its version after a push', async () => {
    const agentId = await createAgent('Shared');
    const v1 = await push(agentId, 1, 'Version one.');
    const shares = applicationContext()?.shares ?? null;
    if (shares === null) throw new Error('the shares runtime was installed');
    const share = await root.shares.forScope(scope).create({
      token: `pub_${agentId}`,
      subjectType: 'agent',
      subjectId: agentId,
      subjectLabel: 'Shared',
      visibility: 'public',
      mode: 'runnable',
      snapshot: null,
      include: {},
      budgetCapUsd: '5',
      expiresAt: null,
      passphraseHash: null,
      createdBy: ownerId,
      publisherPrincipalId: principalId,
    });
    const installed = api();
    const launched: LaunchContext[] = [];
    installTestRunApi({ ...installed, launch: (context) => launched.push(context) });
    try {
      const sessionId = crypto.randomUUID();
      await shares.runPublic({ workspaceId, share, prompt: 'First.', sessionId });
      expect((await root.sessions.forScope(scope).get(sessionId))?.agentVersionId).toBe(v1);
      // A session takes one run at a time: the first ends before the visitor sends again.
      await installed.store.finish(launched[0]?.run.id ?? '', 'completed', null);

      // v2 moves the row to another engine and drops `readFiles`.
      await push(agentId, 2, 'Version two.', {
        policy: { engine: 'pi', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits },
      });
      await root.agents
        .forScope(scope)
        .update(agentId, { permissions: { ...FIXTURE_PERMISSIONS, readFiles: false } });
      await shares.runPublic({ workspaceId, share, prompt: 'Second.', sessionId });
      expect((await root.sessions.forScope(scope).get(sessionId))?.agentVersionId).toBe(v1);
      expect(launched.map((context) => context.agent.engine)).toEqual([
        'claude-agent-sdk',
        'claude-agent-sdk',
      ]);
      expect(launched[1]?.permissionOverride).toMatchObject({ readFiles: true });
    } finally {
      installTestRunApi(installed);
    }
  }, 60_000);
});
