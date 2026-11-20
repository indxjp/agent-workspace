/**
 * #1848 slice 1c on PostgreSQL: the production composition (`register()`) gives every workspace with
 * the `builder` feature on its Builder, once, and switching the feature on through the use case
 * gives one to a workspace that had it off, unless it is switched off again first. A workspace made
 * by the create handler gets one too. The stores, the version pipeline and the advisory lock are the
 * real ones. A Builder provisioned before first-run setup made its model connection and runtime
 * profile picks both up once they exist (slice 1d).
 */
import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { workspaceFeatures } from '@agent-workspace/core/db/unscoped';

import { setupConnectionName } from '../setup/wiring';
import { updateWorkspaceFeatures } from '../workspaces/features';
import { createWorkspace } from '../workspaces/handlers';
import { register } from './register';
import {
  auditCount,
  builderRow,
  builders,
  connection,
  createOwnedWorkspace,
  installed,
  modelList,
  preflightCode,
  setupProfile,
  useCompositionHarness,
  versionIds,
  type CompositionHarness,
  type TestDb,
  type TestWorkspace,
} from './builder-provisioning.test-support';

/** The connection first-run setup makes for the Builder's provider. */
const SETUP_CONNECTION = setupConnectionName('anthropic');

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[composition/builder-provisioning.integration.test.ts] SKIPPED — TEST_DATABASE_URL is not ' +
      'set, so the Builder was not provisioned against the real composition root.',
  );
}

type Runtime = ReturnType<typeof installed>['workspaceFeatures'];

/** The feature repository of a registered workspace. */
async function featureRepository(runtime: Runtime, workspaceId: string) {
  const repository = await runtime.repositoryFor(workspaceId);
  if (repository === null) throw new Error('the workspace has no feature repository');
  return repository;
}

/** Write the workspace's disabled features as its Owner, provisioning through `provisionBuilder`. */
function writeFeatures(
  runtime: Runtime,
  repository: NonNullable<Awaited<ReturnType<Runtime['repositoryFor']>>>,
  ws: TestWorkspace,
  disabled: readonly string[],
  provisionBuilder: () => Promise<void>,
) {
  return updateWorkspaceFeatures({
    deployment: runtime.deployment,
    repository,
    recordAudit: (event) => runtime.recordAuditEvent(event),
    provisionBuilder,
    workspaceId: ws.id,
    actor: { principalId: ws.principalId, userId: ws.userId, label: 'Owner' },
    body: { disabled },
  });
}

async function provisionsOnceAndStartingAgainChangesNothing(h: CompositionHarness) {
  const { db } = await h.start();
  const ws = await createOwnedWorkspace(db, 'builder-fresh');

  h.composition = await register();
  const first = await builders(db, ws.id);
  expect(first.map((row) => row.builtinKey)).toEqual(['builder']);
  const audits = await auditCount(db, ws.id);

  await h.composition?.close();
  h.composition = await register();
  expect(await builders(db, ws.id)).toEqual(first);
  expect(await auditCount(db, ws.id)).toBe(audits);
}

async function switchOnThroughTheUseCase(h: CompositionHarness) {
  const { db } = await h.start();
  const off = await createOwnedWorkspace(db, 'builder-off');
  const on = await createOwnedWorkspace(db, 'builder-on');
  await db.insert(workspaceFeatures).values({ workspaceId: off.id, feature: 'builder' });

  h.composition = await register();
  expect(await builders(db, off.id)).toEqual([]);
  expect(await builders(db, on.id)).toHaveLength(1);

  const runtime = installed().workspaceFeatures;
  const repository = await featureRepository(runtime, off.id);
  const switchOn = () =>
    writeFeatures(runtime, repository, off, [], () => runtime.provisionBuilder(off.id));

  expect((await switchOn()).status).toBe(200);
  expect(await builders(db, off.id)).toHaveLength(1);
  expect((await switchOn()).status).toBe(200);
  expect(await builders(db, off.id)).toHaveLength(1);
}

async function switchedOffBeforeProvisioning(h: CompositionHarness) {
  const { db } = await h.start();
  const ws = await createOwnedWorkspace(db, 'builder-flicker');
  await db.insert(workspaceFeatures).values({ workspaceId: ws.id, feature: 'builder' });

  h.composition = await register();
  const runtime = installed().workspaceFeatures;
  const repository = await featureRepository(runtime, ws.id);
  const pending: (() => Promise<void>)[] = [];
  const write = (disabled: readonly string[]) =>
    writeFeatures(runtime, repository, ws, disabled, () => {
      // Held back, so the switch-off below commits between the switch-on and its provisioning.
      pending.push(() => runtime.provisionBuilder(ws.id));
      return Promise.resolve();
    });

  expect((await write([])).status).toBe(200);
  expect((await write(['builder'])).status).toBe(200);
  expect(pending).toHaveLength(1);
  for (const run of pending) await run();
  expect(await builders(db, ws.id)).toEqual([]);
}

async function createHandlerProvisions(h: CompositionHarness) {
  const { db } = await h.start();
  const creator = await createOwnedWorkspace(db, 'builder-creator');

  h.composition = await register();
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
}

async function deploymentWithoutTheFeature(h: CompositionHarness) {
  const { db } = await h.start();
  const ws = await createOwnedWorkspace(db, 'builder-not-installed');
  process.env['AW_DEPLOYMENT_FEATURES'] = 'chat,runs';

  h.composition = await register();
  expect(await builders(db, ws.id)).toEqual([]);
}

async function twoStartUpPassesAtOnce(h: CompositionHarness) {
  const { db } = await h.start();
  const ws = await createOwnedWorkspace(db, 'builder-race');

  const [a, b] = await Promise.all([register(), register()]);
  try {
    expect(await builders(db, ws.id)).toHaveLength(1);
  } finally {
    await Promise.all([a?.close(), b?.close()]);
  }
}

interface BeforeSetup {
  readonly db: TestDb;
  readonly ws: TestWorkspace;
  readonly baseUrl: string;
}

/** Start-up provisions the Builder while the workspace has neither connection nor profile. */
async function withBuilderBeforeSetup(
  h: CompositionHarness,
  slug: string,
  body: (setup: BeforeSetup) => Promise<void>,
) {
  const { db } = await h.start();
  const ws = await createOwnedWorkspace(db, slug);
  process.env['MASTER_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');
  process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
  const models = await modelList();
  try {
    h.composition = await register();
    await body({ db, ws, baseUrl: models.baseUrl });
  } finally {
    await models.close();
  }
}

async function pickedUpOnceSetupExists(h: CompositionHarness) {
  await withBuilderBeforeSetup(h, 'builder-before-setup', async ({ db, ws, baseUrl }) => {
    const before = await builderRow(db, ws.id);
    expect(before).toMatchObject({ modelConnectionId: null, runtimeProfileId: null });
    const versions = await versionIds(db, before.id);

    const profileId = await setupProfile(db, ws.id);
    const connectionId = await connection(ws.id, 'default', baseUrl);

    expect(await builderRow(db, ws.id)).toEqual({
      id: before.id,
      modelConnectionId: connectionId,
      runtimeProfileId: profileId,
    });
    expect(await versionIds(db, before.id)).toEqual(versions);
    const refusal = await preflightCode(ws, before.id);
    expect(refusal).not.toBe('builder_model_unavailable');
    expect(refusal).not.toBe('agent_runtime_profile_missing');
  });
}

async function bindsToSetupConnection(h: CompositionHarness) {
  await withBuilderBeforeSetup(h, 'builder-setup-connection', async ({ db, ws, baseUrl }) => {
    const before = await builderRow(db, ws.id);
    const versions = await versionIds(db, before.id);

    await setupProfile(db, ws.id);
    const setupConnectionId = await connection(ws.id, SETUP_CONNECTION, baseUrl);

    expect((await builderRow(db, ws.id)).modelConnectionId).toBe(setupConnectionId);
    expect(await versionIds(db, before.id)).toEqual(versions);
    // A new session reads the row; a later turn re-reads the version its session pinned.
    expect(await preflightCode(ws, before.id)).not.toBe('builder_model_unavailable');
    for (const versionId of versions) {
      expect(await preflightCode(ws, before.id, versionId)).not.toBe('builder_model_unavailable');
    }
  });
}

async function defaultConnectionWins(h: CompositionHarness) {
  await withBuilderBeforeSetup(h, 'builder-default-wins', async ({ db, ws, baseUrl }) => {
    await setupProfile(db, ws.id);
    await connection(ws.id, SETUP_CONNECTION, baseUrl);
    const defaultId = await connection(ws.id, 'default', baseUrl);

    expect((await builderRow(db, ws.id)).modelConnectionId).toBe(defaultId);
  });
}

describe.skipIf(!hasDatabase)('the Builder through the production composition', () => {
  const harness = useCompositionHarness();
  const timeout = 180_000;

  it(
    'gives a fresh workspace with the builder feature on exactly one Builder at start-up, and starting again changes nothing',
    () => provisionsOnceAndStartingAgainChangesNothing(harness),
    timeout,
  );
  it(
    'creates nothing for a workspace with the builder feature off, and one Builder when it is switched on through the use case',
    () => switchOnThroughTheUseCase(harness),
    timeout,
  );
  it(
    'creates nothing when the feature is switched off again before the switch-on provisions',
    () => switchedOffBeforeProvisioning(harness),
    timeout,
  );
  it(
    'gives a workspace created through the create handler exactly one Builder',
    () => createHandlerProvisions(harness),
    timeout,
  );
  it(
    'does nothing when the deployment leaves the builder feature out',
    () => deploymentWithoutTheFeature(harness),
    timeout,
  );
  it(
    'creates one Builder when two start-up passes run at once',
    () => twoStartUpPassesAtOnce(harness),
    timeout,
  );
  it(
    'makes a Builder provisioned before setup runnable once its connection and profile exist, without a new version',
    () => pickedUpOnceSetupExists(harness),
    timeout,
  );
  it(
    'binds the Builder to the connection first-run setup makes when the workspace has no "default" connection',
    () => bindsToSetupConnection(harness),
    timeout,
  );
  it(
    'keeps the Builder on the "default" connection when setup\'s connection exists beside it',
    () => defaultConnectionWins(harness),
    timeout,
  );
});
