import { describe } from 'vitest';
import { registerBootstrapTests } from './surface-sessions.bootstrap.test-support';
import { registerResumeTests } from './surface-sessions.resume.test-support';
import { createSurfaceSessionFixture } from './surface-sessions.test-support';
import { registerVersionsTests } from './surface-sessions.versions.test-support';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('the surface session bootstrap through register() (S1-17)', () => {
  const fixture = createSurfaceSessionFixture(process.env);
  registerBootstrapTests(fixture);
  registerResumeTests(fixture);
  registerVersionsTests(fixture);
});
