import { expect, it } from 'vitest';
import { managerDriverOptions, RuntimeDriverConfigurationError } from './manager-start.js';
import { TOKEN } from './manager-start.fixture.test-support.js';

const images = { AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'alpine:3.20' };

it.each(['sandbox-runtime', 'local', 'dockr'])(
  'runner manager driver selection (#818) > refuses RUNTIME_DRIVER=%s instead of running Docker under that label',
  (driver) => {
    let caught: unknown;
    try {
      managerDriverOptions({ ...images, RUNTIME_DRIVER: driver });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeDriverConfigurationError);
    const refusal = caught as RuntimeDriverConfigurationError;
    expect(refusal.driver).toBe(driver);
    expect(refusal.message).toContain(
      'docker, cloud-run-service, aca-sessions, external, vercel-sandbox, cloudflare-sandbox, kubernetes',
    );
    expect(refusal.message).not.toContain(driver);
  },
);

it.each([undefined, '', '  ', 'docker', ' docker\r'])(
  'runner manager driver selection (#818) > serves Docker for RUNTIME_DRIVER=%j',
  (driver) => {
    const options = managerDriverOptions({ ...images, RUNTIME_DRIVER: driver });
    expect(options.configurationFingerprint).toMatch(/^docker:/u);
  },
);

it('runner manager driver selection (#818) > still serves aca-sessions', () => {
  const options = managerDriverOptions({
    RUNTIME_DRIVER: 'aca-sessions',
    RUNNER_MANAGER_TOKEN: TOKEN,
    ACA_SESSION_POOL_ENDPOINT: 'https://pool.westeurope.azurecontainerapps.io/subscriptions/pool',
  });
  expect(options.expectedDriver).toBe('aca-sessions');
});
