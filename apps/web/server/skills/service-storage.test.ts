import { describe, it } from 'vitest';
import { registerConcurrentRevisionsTests } from './service-storage-concurrent-revisions.test-support';
import {
  createRowsWorld,
  memoryFixture,
  postgresFixture,
  registerStorageFixture,
  type Fixture,
} from './service-storage-fixture.test-support';
import { registerImportsTests } from './service-storage-imports.test-support';
import { registerLegacyMovesTests } from './service-storage-legacy-moves.test-support';
import { registerLegacyReadsTests } from './service-storage-legacy-reads.test-support';
import { registerPublishingTests } from './service-storage-publishing.test-support';
import { registerStorageReadsTests } from './service-storage-reads.test-support';
import { registerRevisionRowsTests } from './service-storage-revisions.test-support';
import { registerStorageWritesTests } from './service-storage-writes.test-support';
const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
registerStorageFixture(hasDatabase);
function defineSuite(name: string, setup: () => Promise<Fixture>, ready: boolean): void {
  describe(`skill import on the ${name}`, () => {
    if (!ready) {
      it('has the database it needs', () => {
        throw new Error(
          'TEST_DATABASE_URL is not set; the PostgreSQL suite must run in `pnpm test`',
        );
      });
      return;
    }
    const rowsWorld = createRowsWorld(setup);
    registerImportsTests(rowsWorld);
    registerPublishingTests(rowsWorld);
    registerStorageReadsTests(rowsWorld);
    registerStorageWritesTests(rowsWorld);
    registerRevisionRowsTests(rowsWorld);
    registerLegacyMovesTests(rowsWorld);
    registerConcurrentRevisionsTests(rowsWorld);
    registerLegacyReadsTests(rowsWorld);
  });
}
defineSuite('in-memory catalog', memoryFixture, true);
defineSuite('PostgreSQL catalog', postgresFixture, hasDatabase);
