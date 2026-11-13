import { beforeAll, describe } from 'vitest';
import { registerCatalogTests } from './file-search.catalog.test-support';
import './file-search.extraction.test-support';
import './file-search.run-scope.test-support';
import {
  createFileSearchFixture,
  initializeDatabase,
  memoryWorld,
  postgresWorld,
  type World,
} from './file-search.test-support';

function defineCatalogSuite(name: string, setup: () => Promise<World>) {
  describe(`search through the catalog service on the ${name}`, () => {
    const fixture = createFileSearchFixture(setup);
    registerCatalogTests(fixture);
  });
}
defineCatalogSuite('in-memory catalog', memoryWorld);
defineCatalogSuite('PostgreSQL catalog', postgresWorld);

beforeAll(() => initializeDatabase(process.env['TEST_DATABASE_URL']), 180_000);
