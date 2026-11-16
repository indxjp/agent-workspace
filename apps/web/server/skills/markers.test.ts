const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
import { beforeAll } from 'vitest';
import { startFixtureDatabase } from './markers.fixture.test-support';
beforeAll(() => startFixtureDatabase(process.env['TEST_DATABASE_URL']), 180_000);
import { describe, it } from 'vitest';
import { createSkillMarkerFixture } from './markers.harness.test-support';
import { registerSkillMarkerDeletionTests } from './markers.deletion.test-support';
import { registerSkillMarkerBuiltinsTests } from './markers.builtins.test-support';
import { registerSkillMarkerAssignmentsTests } from './markers.assignments.test-support';
import { registerSkillMarkerMetadataTests } from './markers.metadata.test-support';
import { type Fixture, memoryFixture, postgresFixture } from './markers.fixture.test-support';
function defineSuite(name: string, setup: () => Promise<Fixture>, ready: boolean) {
  describe(`skill records on the ${name}`, () => {
    if (!ready) {
      it('has the database it needs', () => {
        throw new Error(
          'TEST_DATABASE_URL is not set; the PostgreSQL suite must run in `pnpm test`',
        );
      });
      return;
    }
    const fixture = createSkillMarkerFixture(setup);
    registerSkillMarkerDeletionTests(() => fixture);
    registerSkillMarkerBuiltinsTests(() => fixture);
    registerSkillMarkerAssignmentsTests(() => fixture);
    registerSkillMarkerMetadataTests(() => fixture);
  });
}
defineSuite('in-memory catalog', memoryFixture, true);
defineSuite('PostgreSQL catalog', postgresFixture, hasDatabase);
