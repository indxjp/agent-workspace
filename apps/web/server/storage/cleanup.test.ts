import { describe } from 'vitest';
import { memoryCleanupFixture, postgresCleanupFixture } from './cleanup.fixture.test-support';
import { registerCleanupReferencesTests } from './cleanup.references.test-support';
import { registerCleanupUploadsTests } from './cleanup.uploads.test-support';
import { registerCleanupDeletionTests } from './cleanup.deletion.test-support';

function defineSuite(name: string, setup: typeof memoryCleanupFixture) {
  describe(`cleanup on the ${name}`, () => {
    registerCleanupReferencesTests(setup);
    registerCleanupUploadsTests(setup);
    registerCleanupDeletionTests(setup);
  });
}
defineSuite('in-memory catalog', memoryCleanupFixture);
defineSuite('PostgreSQL catalog', postgresCleanupFixture);
