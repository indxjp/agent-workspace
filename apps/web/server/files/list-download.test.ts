import { beforeAll } from 'vitest';
import { startFixtureDatabase } from './list-download.fixture.test-support';
beforeAll(() => startFixtureDatabase(process.env['TEST_DATABASE_URL']), 180_000);
import { describe } from 'vitest';
import { createFileReadFixture } from './list-download.harness.test-support';
import { registerFileReadListingTests } from './list-download.listing.test-support';
import { registerFileReadDownloadsTests } from './list-download.downloads.test-support';
import { registerFileReadAreasTests } from './list-download.areas.test-support';
import { registerFileReadMemoryTests } from './list-download.memory.test-support';
import { type World, memoryWorld, postgresWorld } from './list-download.fixture.test-support';
function defineSuite(name: string, setup: () => Promise<World>) {
  describe(`list and download on the ${name}`, () => {
    const fixture = createFileReadFixture(setup);
    registerFileReadListingTests(() => fixture);
    registerFileReadDownloadsTests(() => fixture);
    registerFileReadAreasTests(() => fixture);
    registerFileReadMemoryTests(() => fixture);
  });
}
defineSuite('in-memory catalog', memoryWorld);
defineSuite('PostgreSQL catalog', postgresWorld);
