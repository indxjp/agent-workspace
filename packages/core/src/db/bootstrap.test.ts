/**
 * S1-03 (issue #441, contract C2): `prepareDatabase` returns the seed's ids, and the same ids on
 * every call against the same database. Skipped loudly without `TEST_DATABASE_URL`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prepareDatabase } from './bootstrap.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './repositories/testing.js';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[bootstrap.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so prepareDatabase did NOT ' +
      'run against a real database.',
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

describe.skipIf(!hasDatabase)('prepareDatabase', () => {
  let isolated: IsolatedTestDatabase;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_bootstrap');
  }, 120_000);

  afterAll(async () => {
    await isolated.close();
  });

  it('returns the seed ids, and the same ids on a second call', async () => {
    const env = { DATABASE_URL: isolated.url, BOOTSTRAP_ADMIN: 'owner@example.test' };

    const first = await prepareDatabase(env);
    expect(first.workspaceId).toMatch(UUID);
    expect(first.adminUserId).toMatch(UUID);
    expect(first.generalAgentId).toMatch(UUID);

    await expect(prepareDatabase(env)).resolves.toEqual(first);
  }, 120_000);
});
