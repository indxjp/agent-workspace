/**
 * The skills adopt stage on two servers at once, against PostgreSQL and a live S3 endpoint (the
 * repository test launcher supplies both, natively or in Docker). With the start-up lock, the second
 * server does not run the pass; without it, the conversion itself still leaves one complete set of
 * rows.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import { openObjectStore, openRootObjectStore } from '@agent-workspace/core/storage';

import { createSkillRowsWorld, seedBareSkill } from '../skills/rows-fixture';
import { runSkillsAdoptStage, type SkillsAdoptDependencies } from './migrate-skills';

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
const b64 = (text: string) => Buffer.from(text).toString('base64');

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
const endpoint = process.env['TEST_S3_ENDPOINT']?.trim() ?? '';

describe('the skills adopt stage on two servers, PostgreSQL and S3', () => {
  if (!hasDatabase || endpoint === '') {
    it('has the services it needs', () => {
      throw new Error(
        'TEST_DATABASE_URL or TEST_S3_ENDPOINT is not set; this suite must run in `pnpm test`',
      );
    });
    return;
  }

  let isolated: IsolatedTestDatabase;
  let root: DatabaseRoot;
  let deps: SkillsAdoptDependencies;
  let rowPaths: (folder: string) => Promise<string[]>;
  let seed: (name: string) => Promise<void>;
  const workspaceId = randomUUID();
  const principalId = randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_skills_adopt_race');
    const { db } = isolated;
    const userId = randomUUID();
    const membershipId = randomUUID();
    await db.insert(workspaces).values({ id: workspaceId, slug: workspaceId, name: 'Race' });
    await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
    await db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
    const scope = await createDatabaseWorkspaceScopeResolver(db).forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('the workspace scope did not resolve');
    const catalog = createDatabaseResourceCatalogRepositoryProvider(db).forScope(scope);
    const location = {
      kind: 's3' as const,
      bucket: `aw-skills-adopt-${randomUUID()}`,
      prefix: '',
      endpoint,
      region: process.env['TEST_S3_REGION'] ?? 'us-east-1',
      forcePathStyle: true,
    };
    const options = {
      credentials: {
        accessKeyId: process.env['TEST_S3_ACCESS_KEY_ID'] ?? 'agent_workspace',
        secretAccessKey: process.env['TEST_S3_SECRET_ACCESS_KEY'] ?? 'agent_workspace',
      },
      createBucketIfMissing: true,
    };
    // The rows' objects go to the root; old skills sit in the skills area, as a deployment opens them.
    const live = await openRootObjectStore(location, options);
    const old = (await openObjectStore(location, 'skills', options)).forWorkspace(workspaceId);
    const { storage } = createSkillRowsWorld(live, workspaceId, catalog);
    deps = {
      workspaceIds: () => root.listWorkspaceIds(),
      objects: () => old,
      catalog: () => Promise.resolve(catalog),
      ownerPrincipalId: (id) => root.workspaces.ownerPrincipalId(id),
      storage,
      runs: root.storageMigrationRuns,
      log: noLog,
    };
    rowPaths = async (folder) =>
      (await storage.list({ workspaceId }, 'skills', folder)).rows.map((row) => row.path).sort();
    seed = (name) =>
      seedBareSkill(old, {
        name,
        files: [
          {
            path: 'SKILL.md',
            contentBase64: b64(`---\nname: ${name}\ndescription: A race.\n---\n`),
          },
          { path: 's/run.sh', contentBase64: b64('run') },
        ],
      });
  }, 180_000);

  afterAll(async () => {
    await root.close();
    await isolated.close();
  });

  // @story US-STO-13
  it('[US-STO-13][api][cli] the second server does not run the pass while the first holds the lock', async () => {
    await seed('locked');
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    let enter: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const first = root.withNamedLock('storage-migrate-skills', () =>
      runSkillsAdoptStage({
        ...deps,
        workspaceIds: async () => {
          enter();
          await released;
          return deps.workspaceIds();
        },
      }),
    );
    await entered;

    const second = await root.withNamedLock('storage-migrate-skills', () =>
      runSkillsAdoptStage(deps),
    );
    release();

    expect(second.acquired).toBe(false);
    expect((await first).acquired).toBe(true);
    expect(await rowPaths('.skills/locked')).toEqual([
      '.skills/locked/SKILL.md',
      '.skills/locked/s/run.sh',
    ]);
  });

  // @story US-STO-13
  it('[US-STO-13][api][cli] two passes racing without the lock leave one complete set of rows', async () => {
    await seed('raced');

    const reports = await Promise.all([runSkillsAdoptStage(deps), runSkillsAdoptStage(deps)]);

    expect(reports.map((report) => report.failed)).toEqual([0, 0]);
    expect(await rowPaths('.skills/raced')).toEqual([
      '.skills/raced/SKILL.md',
      '.skills/raced/s/run.sh',
    ]);
    expect(await root.storageMigrationRuns.latest('skills')).toMatchObject({
      legacyRows: 0,
      mismatches: 0,
    });
  });
});
