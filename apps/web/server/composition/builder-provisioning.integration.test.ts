/**
 * #1848 slice 1c on PostgreSQL: the production composition (`register()`) gives every workspace with
 * the `builder` feature on its Builder, once, and switching the feature on through the use case
 * gives one to a workspace that had it off, unless it is switched off again first. A workspace made
 * by the create handler gets one too. The stores, the version pipeline and the advisory lock are the
 * real ones. A Builder provisioned before first-run setup made its model connection and runtime
 * profile picks both up once they exist (slice 1d).
 */
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { and, count, eq, isNotNull } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { BUILDER_MODEL } from '@indx-workspace/contracts/builder';
import {
  agents,
  agentVersions,
  auditEvents,
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  memberships,
  runtimeProfiles,
  users,
  workspaceFeatures,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import { applicationContext, clearApplicationContext } from '../application-context';
import { resetTestRunApi } from '../application-context-fixtures';
import { getRunApi } from '../runs/environment';
import { setupConnectionName } from '../setup/runtime';
import { updateWorkspaceFeatures } from '../workspaces/features';
import { createWorkspace } from '../workspaces/handlers';
import { register, type RegisteredComposition } from './register';

/** The connection first-run setup makes for the Builder's provider. */
const SETUP_CONNECTION = setupConnectionName('anthropic');

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[composition/builder-provisioning.integration.test.ts] SKIPPED — TEST_DATABASE_URL is not ' +
      'set, so the Builder was not provisioned against the real composition root.',
  );
}

const CONTROLLED_ENV = [
  'AW_DEPLOYMENT_FEATURES',
  'AW_STORAGE_URL',
  'BOOTSTRAP_ADMIN',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'WORKSPACE_SLUG',
  'DATABASE_URL',
  'GATEWAY_TOKEN_SECRET',
  'MASTER_ENCRYPTION_KEY',
  'NEXT_RUNTIME',
  'RUNNER_MANAGER_TOKEN',
  'RUNNER_MANAGER_URL',
  'RUNNER_URL',
  'SESSION_SECRET',
] as const;

describe.skipIf(!hasDatabase)('the Builder through the production composition', () => {
  let isolated: IsolatedTestDatabase | undefined;
  let composition: RegisteredComposition | undefined;
  const previousEnv = new Map<string, string | undefined>();

  afterEach(async () => {
    for (const key of CONTROLLED_ENV) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previousEnv.clear();
    clearApplicationContext();
    resetTestRunApi();
    if (isolated !== undefined) {
      await closeIsolatedTestResources(
        isolated,
        ...(composition === undefined ? [] : [composition]),
      );
    }
    isolated = undefined;
    composition = undefined;
  });

  async function start(): Promise<IsolatedTestDatabase> {
    for (const key of CONTROLLED_ENV) previousEnv.set(key, process.env[key]);
    for (const key of CONTROLLED_ENV) delete process.env[key];
    isolated = await createIsolatedTestDatabase('aw_composition_builder_provisioning');
    process.env['DATABASE_URL'] = isolated.url;
    process.env['SESSION_SECRET'] = 'composition-builder-test-secret-at-least-32-characters';
    return isolated;
  }

  /** A workspace with one Owner membership and its principal. */
  async function workspace(
    db: IsolatedTestDatabase['db'],
    slug: string,
  ): Promise<{ id: string; principalId: string; userId: string }> {
    const id = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    await db.insert(workspaces).values({ id, slug, name: slug });
    await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: slug });
    await db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipId, workspaceId: id, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId: id, kind: 'membership', membershipId });
    });
    return { id, principalId, userId };
  }

  async function builders(db: IsolatedTestDatabase['db'], workspaceId: string) {
    return db
      .select({ id: agents.id, builtinKey: agents.builtinKey })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), isNotNull(agents.builtinKey)));
  }

  function installed() {
    const application = applicationContext();
    if (application === null) throw new Error('the composition installed no application context');
    return application;
  }

  async function auditCount(db: IsolatedTestDatabase['db'], workspaceId: string) {
    const [row] = await db
      .select({ total: count() })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, workspaceId));
    return row?.total ?? 0;
  }

  it('gives a fresh workspace with the builder feature on exactly one Builder at start-up, and starting again changes nothing', async () => {
    const { db } = await start();
    const ws = await workspace(db, 'builder-fresh');

    composition = await register();
    const first = await builders(db, ws.id);
    expect(first.map((row) => row.builtinKey)).toEqual(['builder']);
    const audits = await auditCount(db, ws.id);

    await composition?.close();
    composition = await register();
    expect(await builders(db, ws.id)).toEqual(first);
    expect(await auditCount(db, ws.id)).toBe(audits);
  }, 180_000);

  it('creates nothing for a workspace with the builder feature off, and one Builder when it is switched on through the use case', async () => {
    const { db } = await start();
    const off = await workspace(db, 'builder-off');
    const on = await workspace(db, 'builder-on');
    await db.insert(workspaceFeatures).values({ workspaceId: off.id, feature: 'builder' });

    composition = await register();
    expect(await builders(db, off.id)).toEqual([]);
    expect(await builders(db, on.id)).toHaveLength(1);

    const runtime = installed().workspaceFeatures;
    const repository = await runtime.repositoryFor(off.id);
    if (repository === null) throw new Error('the workspace has no feature repository');
    const switchOn = () =>
      updateWorkspaceFeatures({
        deployment: runtime.deployment,
        repository,
        recordAudit: (event) => runtime.recordAuditEvent(event),
        provisionBuilder: () => runtime.provisionBuilder(off.id),
        workspaceId: off.id,
        actor: { principalId: off.principalId, userId: off.userId, label: 'Owner' },
        body: { disabled: [] },
      });

    expect((await switchOn()).status).toBe(200);
    expect(await builders(db, off.id)).toHaveLength(1);
    expect((await switchOn()).status).toBe(200);
    expect(await builders(db, off.id)).toHaveLength(1);
  }, 180_000);

  it('creates nothing when the feature is switched off again before the switch-on provisions', async () => {
    const { db } = await start();
    const ws = await workspace(db, 'builder-flicker');
    await db.insert(workspaceFeatures).values({ workspaceId: ws.id, feature: 'builder' });

    composition = await register();
    const runtime = installed().workspaceFeatures;
    const repository = await runtime.repositoryFor(ws.id);
    if (repository === null) throw new Error('the workspace has no feature repository');
    const pending: (() => Promise<void>)[] = [];
    const write = (disabled: readonly string[]) =>
      updateWorkspaceFeatures({
        deployment: runtime.deployment,
        repository,
        recordAudit: (event) => runtime.recordAuditEvent(event),
        // Held back, so the switch-off below commits between the switch-on and its provisioning.
        provisionBuilder: () => {
          pending.push(() => runtime.provisionBuilder(ws.id));
          return Promise.resolve();
        },
        workspaceId: ws.id,
        actor: { principalId: ws.principalId, userId: ws.userId, label: 'Owner' },
        body: { disabled },
      });

    expect((await write([])).status).toBe(200);
    expect((await write(['builder'])).status).toBe(200);
    expect(pending).toHaveLength(1);
    for (const run of pending) await run();
    expect(await builders(db, ws.id)).toEqual([]);
  }, 180_000);

  it('gives a workspace created through the create handler exactly one Builder', async () => {
    const { db } = await start();
    const creator = await workspace(db, 'builder-creator');

    composition = await register();
    const application = installed();
    const created = await createWorkspace(
      application.workspaces.repository,
      creator.userId,
      { name: 'Created', slug: 'builder-created' },
      (id) => application.workspaceFeatures.provisionBuilder(id),
    );
    expect(created.status).toBe(201);
    const { workspace: made } = created.body as { workspace: { id: string } };
    const rows = await builders(db, made.id);
    expect(rows.map((row) => row.builtinKey)).toEqual(['builder']);
  }, 180_000);

  it('does nothing when the deployment leaves the builder feature out', async () => {
    const { db } = await start();
    const ws = await workspace(db, 'builder-not-installed');
    process.env['AW_DEPLOYMENT_FEATURES'] = 'chat,runs';

    composition = await register();
    expect(await builders(db, ws.id)).toEqual([]);
  }, 180_000);

  it('creates one Builder when two start-up passes run at once', async () => {
    const { db } = await start();
    const ws = await workspace(db, 'builder-race');

    const [a, b] = await Promise.all([register(), register()]);
    try {
      expect(await builders(db, ws.id)).toHaveLength(1);
    } finally {
      await Promise.all([a?.close(), b?.close()]);
    }
  }, 180_000);

  /** A loopback stand-in for the provider's model list, offering the Builder's pinned model. */
  async function modelList(): Promise<{ readonly baseUrl: string; close(): Promise<void> }> {
    const server = createServer((request, response) => {
      if (request.method === 'GET' && request.url?.startsWith('/v1/models') === true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ data: [{ id: BUILDER_MODEL, type: 'model' }], has_more: false }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      baseUrl: `http://127.0.0.1:${String(port)}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  async function builderRow(db: IsolatedTestDatabase['db'], workspaceId: string) {
    const [row] = await db
      .select({
        id: agents.id,
        modelConnectionId: agents.modelConnectionId,
        runtimeProfileId: agents.runtimeProfileId,
      })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), isNotNull(agents.builtinKey)));
    if (row === undefined) throw new Error('the workspace has no Builder');
    return row;
  }

  async function versionIds(db: IsolatedTestDatabase['db'], agentId: string) {
    const rows = await db
      .select({ id: agentVersions.id })
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agentId));
    return rows.map((row) => row.id);
  }

  /** The workspace default runtime profile, as setup leaves it. */
  async function setupProfile(db: IsolatedTestDatabase['db'], workspaceId: string) {
    const [profile] = await db
      .insert(runtimeProfiles)
      .values({
        workspaceId,
        name: 'setup-local',
        driver: 'local',
        networkPolicy: 'none',
        filesystem: 'read-only',
        workspaceDefault: true,
      })
      .returning({ id: runtimeProfiles.id });
    if (profile === undefined) throw new Error('the runtime profile was not written');
    return profile.id;
  }

  /** Create a model connection through the models API the routes use. */
  async function connection(workspaceId: string, name: string, baseUrl: string) {
    const api = installed().models;
    if (api.kind !== 'serving') throw new Error('the composition installed no models API');
    const created = await api.runtime.models.forWorkspace(workspaceId).create({
      name,
      provider: 'anthropic',
      apiKey: 'sk-ant-builder-before-setup',
      config: { baseUrl },
    });
    if (created.kind !== 'created') throw new Error(`model connection: ${created.kind}`);
    return created.connection.id;
  }

  /**
   * The run-start preflight's refusal code for the Builder: for a new session (no `versionId`, the
   * row) or a turn of a session pinned to version `versionId`.
   */
  async function preflightCode(
    ws: { readonly id: string; readonly principalId: string; readonly userId: string },
    agentId: string,
    versionId?: string,
  ) {
    const runApi = getRunApi();
    if (runApi?.preflight === undefined) throw new Error('the composition installed no preflight');
    const principal = {
      principalId: ws.principalId,
      ownerPrincipalId: ws.principalId,
      userId: ws.userId,
      workspaceId: ws.id,
      role: 'owner' as const,
      scope: null,
    };
    const agent = await runApi.findAgent(principal, agentId);
    if (agent === null) throw new Error('the run API does not find the Builder');
    return (await runApi.preflight(principal, agent, null, null, versionId))?.code;
  }

  it('makes a Builder provisioned before setup runnable once its connection and profile exist, without a new version', async () => {
    const { db } = await start();
    const ws = await workspace(db, 'builder-before-setup');
    process.env['MASTER_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');
    process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
    const models = await modelList();
    try {
      // Start-up provisions the Builder while the workspace has neither.
      composition = await register();
      const before = await builderRow(db, ws.id);
      expect(before).toMatchObject({ modelConnectionId: null, runtimeProfileId: null });
      const versions = await versionIds(db, before.id);

      const profileId = await setupProfile(db, ws.id);
      const connectionId = await connection(ws.id, 'default', models.baseUrl);

      expect(await builderRow(db, ws.id)).toEqual({
        id: before.id,
        modelConnectionId: connectionId,
        runtimeProfileId: profileId,
      });
      expect(await versionIds(db, before.id)).toEqual(versions);
      const refusal = await preflightCode(ws, before.id);
      expect(refusal).not.toBe('builder_model_unavailable');
      expect(refusal).not.toBe('agent_runtime_profile_missing');
    } finally {
      await models.close();
    }
  }, 180_000);

  it('binds the Builder to the connection first-run setup makes when the workspace has no "default" connection', async () => {
    const { db } = await start();
    const ws = await workspace(db, 'builder-setup-connection');
    process.env['MASTER_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');
    process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
    const models = await modelList();
    try {
      composition = await register();
      const before = await builderRow(db, ws.id);
      const versions = await versionIds(db, before.id);

      await setupProfile(db, ws.id);
      const setupConnectionId = await connection(ws.id, SETUP_CONNECTION, models.baseUrl);

      expect((await builderRow(db, ws.id)).modelConnectionId).toBe(setupConnectionId);
      expect(await versionIds(db, before.id)).toEqual(versions);
      // A new session reads the row; a later turn re-reads the version its session pinned.
      expect(await preflightCode(ws, before.id)).not.toBe('builder_model_unavailable');
      for (const versionId of versions) {
        expect(await preflightCode(ws, before.id, versionId)).not.toBe('builder_model_unavailable');
      }
    } finally {
      await models.close();
    }
  }, 180_000);

  it('keeps the Builder on the "default" connection when setup\'s connection exists beside it', async () => {
    const { db } = await start();
    const ws = await workspace(db, 'builder-default-wins');
    process.env['MASTER_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');
    process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
    const models = await modelList();
    try {
      composition = await register();
      await setupProfile(db, ws.id);
      await connection(ws.id, SETUP_CONNECTION, models.baseUrl);
      const defaultId = await connection(ws.id, 'default', models.baseUrl);

      expect((await builderRow(db, ws.id)).modelConnectionId).toBe(defaultId);
    } finally {
      await models.close();
    }
  }, 180_000);
});
