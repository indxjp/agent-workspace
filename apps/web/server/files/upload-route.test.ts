import { beforeAll } from 'vitest';
import { startFixtureDatabase } from './upload-route.fixture.test-support';
beforeAll(() => startFixtureDatabase(process.env['TEST_DATABASE_URL']), 180_000);
import { describe } from 'vitest';
import { createFileUploadFixture } from './upload-route.harness.test-support';
import { registerFileUploadSavingTests } from './upload-route.saving.test-support';
import { registerFileUploadConcurrencyTests } from './upload-route.concurrency.test-support';
import { registerFileUploadAuthorizationTests } from './upload-route.authorization.test-support';
import { registerFileUploadMemoryTests } from './upload-route.memory.test-support';
import { type World, memoryWorld, postgresWorld } from './upload-route.fixture.test-support';
function defineSuite(name: string, setup: () => Promise<World>) {
  describe(`upload on the ${name}`, () => {
    const fixture = createFileUploadFixture(setup);
    registerFileUploadSavingTests(() => fixture);
    registerFileUploadConcurrencyTests(() => fixture);
    registerFileUploadAuthorizationTests(() => fixture);
    registerFileUploadMemoryTests(() => fixture);
  });
}
defineSuite('in-memory catalog', memoryWorld);
defineSuite('PostgreSQL catalog', postgresWorld);
