import { beforeAll } from 'vitest';
import { initializeDatabase } from './move-delete.test-support';
import { describe } from 'vitest';
import { registerConcurrencyTests } from './move-delete.concurrency.test-support';
import { registerDeleteTests } from './move-delete.delete.test-support';
import { registerOwnershipTests } from './move-delete.ownership.test-support';
import { registerRenameTests } from './move-delete.rename.test-support';
import {
  createMoveDeleteFixture,
  memoryWorld,
  postgresWorld,
  type World,
} from './move-delete.test-support';

function defineSuite(name: string, setup: () => Promise<World>) {
  describe(`move and delete on the ${name}`, () => {
    const fixture = createMoveDeleteFixture(setup);
    registerRenameTests(fixture);
    registerConcurrencyTests(fixture);
    registerDeleteTests(fixture);
    registerOwnershipTests(fixture);
  });
}
defineSuite('in-memory catalog', memoryWorld);
defineSuite('PostgreSQL catalog', postgresWorld);

beforeAll(() => initializeDatabase(process.env['TEST_DATABASE_URL']), 180_000);
