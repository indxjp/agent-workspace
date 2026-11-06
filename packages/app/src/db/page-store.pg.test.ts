/**
 * `pageStoreOf` against a real PostgreSQL: the page conformance suite `memoryPageStoreOf` passes,
 * on an `app_t<random>` schema that `migrateApp` creates from the generated SQL (the page tables
 * and their revisions tables) and the suite drops.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { definePages } from '../pages/define-pages.js';
import { fakePerson } from '../testing/fake-person.js';
import {
  describePageStoreConformance,
  PAGE_CONFORMANCE_RESOURCES,
} from '../testing/page-conformance.js';
import { createTestAppSchema, type TestAppSchema } from '../testing/pg-test-schema.js';
import type { PageRevision } from './page-port.js';
import { pageRevisionsTableName } from './page-revisions.js';
import { pageStoreOf } from './page-store.js';
import { appSchemaName } from './schema-name.js';

const rawUrl = process.env['TEST_DATABASE_URL'];
const url = rawUrl === undefined || rawUrl.trim() === '' ? undefined : rawUrl;

if (url === undefined) {
  console.warn(
    '[db/page-store.pg.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so pageStoreOf was NOT ' +
      'exercised against a real PostgreSQL. A green result without it says nothing about the ' +
      'PostgreSQL page store.',
  );
}

describe.skipIf(url === undefined)('pageStoreOf against real PostgreSQL', () => {
  let schema: TestAppSchema | undefined;
  const ready = (): TestAppSchema => {
    if (schema === undefined) throw new Error('the test schema was not created');
    return schema;
  };

  beforeAll(async () => {
    schema = await createTestAppSchema(url ?? '', PAGE_CONFORMANCE_RESOURCES);
  });

  afterAll(async () => {
    await schema?.drop();
  });

  describePageStoreConformance(
    'conforms to the PageStore port',
    (resource, options) => {
      const { db, appName } = ready();
      const table = `"${appSchemaName(appName)}"."${pageRevisionsTableName(resource)}"`;
      return {
        store: pageStoreOf(resource, { db, appName, now: options.now }),
        storedRevisions: async (pageId) => {
          const found = await db.execute(
            sql`SELECT "id", "page_id", "title", "run_id" FROM ${sql.raw(table)} WHERE "page_id" = ${pageId}::uuid ORDER BY "at"`,
          );
          return found.rows as unknown as PageRevision[];
        },
      };
    },
    { describe, it },
  );

  it('keeps an agent save without its run out of the table', async () => {
    const { db, appName } = ready();
    const [pages] = PAGE_CONFORMANCE_RESOURCES;
    if (pages === undefined) throw new Error('no page fixture');
    const table = `"${appSchemaName(appName)}"."${pageRevisionsTableName(pages)}"`;
    await expect(
      db.execute(
        sql`INSERT INTO ${sql.raw(table)} ("workspace_id", "page_id", "title", "blocks", "author_principal_id", "via") VALUES ('w', ${crypto.randomUUID()}::uuid, 't', '[]'::jsonb, 'p', 'agent')`,
      ),
    ).rejects.toThrow();
  });

  it('turns a database failure into internal_error, never its text', async () => {
    const { db } = ready();
    const missing = definePages({
      name: 'missing_page',
      access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
    });
    const store = pageStoreOf(missing, { db, appName: ready().appName });
    await expect(store.create(fakePerson(), { title: 'x' })).rejects.toMatchObject({
      code: 'internal_error',
      message: 'The record store failed. Try again later.',
    });
  });
});
