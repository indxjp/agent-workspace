import crypto from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { workspaces } from '../schema/workspaces.js';
import { createDatabaseWorkspaceFeatureRepositoryProvider } from './workspace-features.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

/** Every constraint name on an error and its causes: drizzle wraps the driver's error. */
function constraintNames(error: unknown): string[] {
  const names: string[] = [];
  let cursor = error;
  for (let depth = 0; depth < 10 && typeof cursor === 'object' && cursor !== null; depth += 1) {
    const name: unknown = (cursor as { constraint?: unknown }).constraint;
    if (typeof name === 'string') names.push(name);
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return names;
}

describe.skipIf(!hasDatabase)('WorkspaceFeatureRepository', () => {
  let isolated: IsolatedTestDatabase;
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();

  const features = async (workspaceId: string) => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    return createDatabaseWorkspaceFeatureRepositoryProvider(isolated.db).forScope(scope);
  };
  const rows = async (workspaceId: string) =>
    (
      await isolated.db.execute(
        sql`select feature from workspace_features where workspace_id = ${workspaceId} order by feature`,
      )
    ).rows.map((row) => row['feature']);

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_workspace_features');
    for (const id of [a, b]) {
      await isolated.db.insert(workspaces).values({ id, slug: id, name: 'Features' });
    }
  }, 180_000);

  afterAll(async () => isolated.close());

  it('lists nothing disabled for a workspace that never switched a feature off', async () => {
    await expect((await features(a)).listDisabled()).resolves.toEqual([]);
  });

  it('replaces the disabled set and lists it in FEATURE_IDS order', async () => {
    const repo = await features(a);
    await expect(repo.replaceDisabled(['skills', 'files'])).resolves.toEqual({
      before: [],
      after: ['files', 'skills'],
    });
    await expect(repo.listDisabled()).resolves.toEqual(['files', 'skills']);
    expect(await rows(a)).toEqual(['files', 'skills']);
  });

  it('removes a feature that is no longer in the set, and clears with an empty set', async () => {
    const repo = await features(a);
    await expect(repo.replaceDisabled(['skills'])).resolves.toEqual({
      before: ['files', 'skills'],
      after: ['skills'],
    });
    expect(await rows(a)).toEqual(['skills']);
    await expect(repo.replaceDisabled([])).resolves.toEqual({ before: ['skills'], after: [] });
    expect(await rows(a)).toEqual([]);
  });

  it('keeps one workspace out of another', async () => {
    await (await features(a)).replaceDisabled(['triggers']);
    await expect((await features(b)).listDisabled()).resolves.toEqual([]);
    await (await features(b)).replaceDisabled(['chat']);
    await expect((await features(a)).listDisabled()).resolves.toEqual(['triggers']);
    expect(await rows(b)).toEqual(['chat']);
  });

  it('is idempotent for the same set', async () => {
    const repo = await features(b);
    await repo.replaceDisabled(['files']);
    await expect(repo.replaceDisabled(['files'])).resolves.toEqual({
      before: ['files'],
      after: ['files'],
    });
    expect(await rows(b)).toEqual(['files']);
  });

  it('leaves exactly one caller’s set when two replaces race, never their union', async () => {
    const raced = crypto.randomUUID();
    await isolated.db.insert(workspaces).values({ id: raced, slug: raced, name: 'Raced' });
    const repo = await features(raced);
    for (let round = 0; round < 20; round += 1) {
      await repo.replaceDisabled([]);
      await Promise.all([repo.replaceDisabled(['files']), repo.replaceDisabled(['skills'])]);
      expect([['files'], ['skills']]).toContainEqual(await repo.listDisabled());
    }
  });

  it('reads each racing replace’s `before` under the lock, so the two chain rather than overlap', async () => {
    const raced = crypto.randomUUID();
    await isolated.db.insert(workspaces).values({ id: raced, slug: raced, name: 'Chained' });
    const repo = await features(raced);
    for (let round = 0; round < 20; round += 1) {
      await repo.replaceDisabled([]);
      const [files, skills] = await Promise.all([
        repo.replaceDisabled(['files']),
        repo.replaceDisabled(['skills']),
      ]);
      // Whichever ran second saw the first one's set, never the empty set both started from.
      const chained =
        (files.before.length === 0 && skills.before.join() === 'files') ||
        (skills.before.length === 0 && files.before.join() === 'skills');
      expect(chained, JSON.stringify({ files, skills })).toBe(true);
    }
  });

  it('rolls the whole replace back when its insert fails', async () => {
    const failing = crypto.randomUUID();
    await isolated.db.insert(workspaces).values({ id: failing, slug: failing, name: 'Failing' });
    const repo = await features(failing);
    await repo.replaceDisabled(['files']);
    // A real constraint, scoped to this workspace, makes the insert half of the replace fail
    // after its delete half has already removed `files`.
    await isolated.db.execute(
      sql.raw(
        `alter table workspace_features add constraint workspace_features_rollback_probe check (workspace_id <> '${failing}' or feature <> 'builder')`,
      ),
    );
    try {
      const error = await repo.replaceDisabled(['chat', 'builder']).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(constraintNames(error)).toContain('workspace_features_rollback_probe');
    } finally {
      await isolated.db.execute(
        sql`alter table workspace_features drop constraint workspace_features_rollback_probe`,
      );
    }
    expect(await rows(failing)).toEqual(['files']);
  });

  it('refuses a feature id the contract does not name, by constraint name', async () => {
    const attempt = isolated.db.execute(
      sql`insert into workspace_features (workspace_id, feature) values (${a}, 'nope')`,
    );
    const error = await attempt.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(constraintNames(error)).toContain('workspace_features_feature_valid');
  });

  it('refuses the same feature twice in one workspace, by constraint name', async () => {
    await (await features(a)).replaceDisabled(['evaluations']);
    const error = await isolated.db
      .execute(
        sql`insert into workspace_features (workspace_id, feature) values (${a}, 'evaluations')`,
      )
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(constraintNames(error)).toContain('workspace_features_workspace_feature_key');
  });

  it('removes a workspace’s rows when the workspace is deleted', async () => {
    const doomed = crypto.randomUUID();
    await isolated.db.insert(workspaces).values({ id: doomed, slug: doomed, name: 'Doomed' });
    await (await features(doomed)).replaceDisabled(['chat', 'files']);
    expect(await rows(doomed)).toEqual(['chat', 'files']);
    await isolated.db.execute(sql`delete from workspaces where id = ${doomed}`);
    expect(await rows(doomed)).toEqual([]);
  });
});
