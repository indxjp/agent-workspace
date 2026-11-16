import { describe, vi } from 'vitest';
import { registerConcurrencyTests } from './setup-concurrency.test-support';
import { registerExternalChecksTests } from './setup-external-checks.test-support';
import { registerExternalCredentialsTests } from './setup-external-credentials.test-support';
import { registerExternalFixture } from './setup-external-fixture.test-support';
import { registerExternalPersistenceTests } from './setup-external-persistence.test-support';
import { registerExternalStartupTests } from './setup-external-startup.test-support';
import { hasDatabase, registerSetupFixture } from './setup-fixture.test-support';
import { registerMaterialisationTests } from './setup-materialisation.test-support';
import { registerRuntimeProfilesTests } from './setup-profiles.test-support';
import { registerProviderRefusalsTests } from './setup-provider-refusals.test-support';
import { registerRollbackTests } from './setup-rollback.test-support';
import { registerRuntimeRefusalsTests } from './setup-runtime-refusals.test-support';
import { registerVertexTests } from './setup-vertex.test-support';
vi.mock('../models/probe', async () => {
  const { GOOD_KEY, GOOD_KEY_2, probes } = await import('./setup-provider.test-support');
  return {
    probeModelConnection: vi.fn(
      async (resolved: { credential: string; connection: { provider: string } }) => {
        probes.active += 1;
        probes.peak = Math.max(probes.peak, probes.active);
        // Long enough for a second, unserialised setup to start its own probe meanwhile.
        await new Promise((resolve) => setTimeout(resolve, 25));
        probes.active -= 1;
        return resolved.connection.provider === 'vertex' ||
          resolved.credential === GOOD_KEY ||
          resolved.credential === GOOD_KEY_2
          ? { ok: true, status: 200, latencyMs: 1, message: 'Connection succeeded.' }
          : { ok: false, status: 401, latencyMs: 1, message: 'Provider returned HTTP 401.' };
      },
    ),
  };
});
if (!hasDatabase) {
  console.warn(
    '[composition/setup.integration.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so setup ' +
      'atomicity (issue #415) was not checked against PostgreSQL.',
  );
}

describe.skipIf(!hasDatabase)('first-run setup is atomic (issue #415, PostgreSQL)', () => {
  registerSetupFixture();
  registerProviderRefusalsTests();
  registerVertexTests();
  registerRollbackTests();
  registerRuntimeProfilesTests();
  registerMaterialisationTests();
  registerConcurrencyTests();
  registerRuntimeRefusalsTests();
  describe('a default driver that needs a provider key (issue #827)', () => {
    registerExternalFixture();
    registerExternalChecksTests();
    registerExternalStartupTests();
    registerExternalPersistenceTests();
    registerExternalCredentialsTests();
  });
});
