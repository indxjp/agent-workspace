import { createServer, type AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { startRunnerManager } from './manager-start.js';

import {
  parseVerificationTimeoutMs,
  readRunnerManagerOptions,
  readRunnerManagerSettings,
  RunnerManagerSettingsError,
  RuntimeDriverConfigurationError,
  startFailureFields,
} from './manager-settings.js';

const TOKEN = 'm'.repeat(32);
const IMAGES = {
  AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'alpine:3.20',
  RUNNER_MANAGER_TOKEN: TOKEN,
};

function refusal(read: () => unknown): RunnerManagerSettingsError {
  try {
    read();
  } catch (error) {
    if (error instanceof RunnerManagerSettingsError) return error;
    throw error;
  }
  throw new Error('expected the settings to be refused');
}

describe('readRunnerManagerSettings', () => {
  it('keeps the defaults it had before the settings module', () => {
    const settings = readRunnerManagerSettings(IMAGES);
    expect(settings.listen).toEqual({ host: '0.0.0.0', port: 8090 });
    expect(settings.options.token).toBe(TOKEN);
    expect(settings.options.workspacesRoot).toBe('/var/lib/agent-workspace/runtimes');
    expect(settings.options.verificationTimeoutMs).toBeUndefined();
    expect(settings.options.configurationFingerprint).toMatch(/^docker:/u);
    expect(typeof settings.reap).toBe('function');
  });

  it('passes the values it is given through', () => {
    const settings = readRunnerManagerSettings({
      ...IMAGES,
      HOST: '127.0.0.1',
      PORT: '9100',
      RUNNER_MANAGER_TOKEN: `${TOKEN} `,
      RUNTIME_WORKSPACES_ROOT: '/srv/runs',
      RUNTIME_VERIFICATION_TIMEOUT_MS: '45000',
    });
    expect(settings.listen).toEqual({ host: '127.0.0.1', port: 9100 });
    // A key is taken as given, untrimmed.
    expect(settings.options.token).toBe(`${TOKEN} `);
    expect(settings.options.workspacesRoot).toBe('/srv/runs');
    expect(settings.options.verificationTimeoutMs).toBe(45_000);
  });

  it('asks the system for a free port with PORT=0, as the embedded local runtime does', () => {
    expect(readRunnerManagerSettings({ ...IMAGES, PORT: ' 0 ' }).listen.port).toBe(0);
  });

  it('names every refused group in one error: the port, the timeout and the driver', () => {
    const error = refusal(() =>
      readRunnerManagerSettings({
        ...IMAGES,
        PORT: 'eighty',
        RUNTIME_VERIFICATION_TIMEOUT_MS: '30s',
        RUNTIME_DRIVER: 'dockr',
      }),
    );
    expect(error.reasons).toHaveLength(3);
    expect(error.reasons[0]).toMatch(/^PORT /u);
    expect(error.reasons[1]).toMatch(/^RUNTIME_VERIFICATION_TIMEOUT_MS /u);
    expect(error.reasons[2]).toMatch(/RUNTIME_DRIVER is not a served driver/u);
    expect(error.message.match(/Runner manager start-up stopped/gu)).toHaveLength(1);
  });

  it('refuses a driver setting by name', () => {
    const error = refusal(() =>
      readRunnerManagerSettings({ ...IMAGES, RUNTIME_PUBLISH: 'everywhere' }),
    );
    expect(error.reasons).toEqual(['runner manager: RUNTIME_PUBLISH must be loopback, or unset.']);
  });

  it('refuses a bad PORT alone', () => {
    const error = refusal(() => readRunnerManagerSettings({ ...IMAGES, PORT: '70000' }));
    expect(error.reasons).toHaveLength(1);
    expect(error.reasons[0]).toMatch(/^PORT /u);
  });
});

describe('RUNNER_MANAGER_TOKEN', () => {
  it.each([undefined, '', 'short', 'm'.repeat(31)])(
    'refuses %j by name, before the manager is built, without repeating it',
    (token) => {
      const error = refusal(() =>
        readRunnerManagerSettings({ ...IMAGES, RUNNER_MANAGER_TOKEN: token }),
      );
      expect(error.reasons).toEqual(['RUNNER_MANAGER_TOKEN must contain at least 32 characters.']);
      if (token !== undefined && token !== '') expect(error.message).not.toContain(token);
    },
  );
});

describe('readRunnerManagerOptions', () => {
  it('does not read the listen address, which the Vercel Function does not use', () => {
    expect(() => readRunnerManagerOptions({ ...IMAGES, PORT: 'eighty' })).not.toThrow();
  });

  it('refuses a bad verification timeout and a bad driver together', () => {
    const error = refusal(() =>
      readRunnerManagerOptions({ RUNTIME_VERIFICATION_TIMEOUT_MS: '0', RUNTIME_DRIVER: 'local' }),
    );
    expect(error.reasons).toHaveLength(3);
    expect(error.reasons[0]).toBe('RUNNER_MANAGER_TOKEN must contain at least 32 characters.');
  });
});

describe('parseVerificationTimeoutMs', () => {
  it.each([
    ['1', 1],
    ['30000', 30_000],
    [' 500 ', 500],
  ])('accepts %j', (value, expected) => {
    expect(parseVerificationTimeoutMs(value)).toBe(expected);
  });

  it('keeps the default when unset', () => {
    expect(parseVerificationTimeoutMs(undefined)).toBeUndefined();
  });

  it.each(['', '0', '-5', '1.5', '30s', 'NaN', '1e3', '99999999999999999999'])(
    'refuses %j, which used to become NaN or a timeout that fires at once',
    (value) => {
      expect(() => parseVerificationTimeoutMs(value)).toThrow(/^RUNTIME_VERIFICATION_TIMEOUT_MS /u);
    },
  );
});

describe('startFailureFields', () => {
  it('logs every refused setting in its own field, so none is cut off', () => {
    const error = refusal(() =>
      readRunnerManagerSettings({
        ...IMAGES,
        PORT: 'eighty',
        RUNTIME_VERIFICATION_TIMEOUT_MS: 'soon',
        RUNTIME_DRIVER: 'dockr',
      }),
    );
    // The joined message is past the 200 characters the logger keeps of one string field.
    expect(error.message.length).toBeGreaterThan(200);
    expect(startFailureFields(error)).toEqual({ refused: error.reasons });
    for (const reason of error.reasons) expect(reason.length).toBeLessThanOrEqual(200);
  });

  it('never repeats a secret it refused', () => {
    const secret = 's'.repeat(20);
    const error = refusal(() =>
      readRunnerManagerSettings({
        RUNTIME_DRIVER: 'external',
        EXTERNAL_PROVIDER: 'e2b',
        GATEWAY_PUBLIC_URL: 'https://gateway.example.com',
        AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'template:build',
        RUNNER_MANAGER_STATELESS: 'true',
        RUNNER_MANAGER_TOKEN: secret,
      }),
    );
    expect(error.reasons.join(' ')).toMatch(/RUNNER_MANAGER_TOKEN must contain at least 32/u);
    expect(JSON.stringify(startFailureFields(error))).not.toContain(secret);
  });

  it('logs any other failure as the error', () => {
    const error = new RuntimeDriverConfigurationError('x');
    expect(startFailureFields(error)).toEqual({ error });
  });
});

describe('startRunnerManager', () => {
  it('listens on the PORT and HOST it was given', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const free = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const manager = await startRunnerManager({ ...IMAGES, HOST: '127.0.0.1', PORT: String(free) });
    try {
      expect(manager.address).toMatchObject({ address: '127.0.0.1', port: free });
    } finally {
      await manager.shutdown();
    }
  });

  it('rejects with every refused setting, and does not exit its caller (the embedded runtime)', async () => {
    const started = startRunnerManager({ ...IMAGES, PORT: 'eighty', RUNTIME_DRIVER: 'dockr' });
    await expect(started).rejects.toBeInstanceOf(RunnerManagerSettingsError);
    await expect(started).rejects.toMatchObject({
      reasons: [expect.stringMatching(/^PORT /u), expect.stringMatching(/RUNTIME_DRIVER/u)],
    });
  });
});
