import { afterEach, describe, expect, it, vi } from 'vitest';

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock('../services', () => ({
  installSecretsApi: () => Promise.resolve({ secrets: null, secretsService: null }),
  installModelsApi: () => Promise.resolve({ models: null, modelsApi: null }),
  installConnectorsApi: () => Promise.resolve(null),
  installEndpointClientsApi: () => null,
  installStorageConnectionsApi: () => null,
  installOAuthApi: () => null,
  installRuntimesApi: () => Promise.resolve({ runtimes: null, runtimeSwitchAudit: null }),
  installDriverRegistry: () => Promise.resolve(),
}));
vi.mock('../session-rbac', () => ({ installSessionTranscripts: () => Promise.resolve(null) }));
vi.mock('../setup', () => ({ installSetupApi: () => Promise.resolve(null) }));
vi.mock('../storage', () => ({
  installFilesApi: () => Promise.resolve({ kind: 'disabled' }),
  installSkillsApi: () => Promise.resolve(null),
}));
vi.mock('../../compose/runtime-manager-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../compose/runtime-manager-client')>()),
  createRuntimeManagerClient: createClient,
}));

import { wireSubsystems } from './subsystems';

const TOKEN = 'subsystems-test-runner-manager-token-over-32';
const MANAGER = 'https://manager-abc.a.run.app';

async function wire(env: Record<string, string>) {
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return wireSubsystems({
    root: { storageConnections: null },
    scopes: {},
    resolveWorkspace: () => Promise.resolve(null),
    identifyAuditActor: () => Promise.resolve(null),
    resourceCatalog: null,
    policyCeiling: null,
    captureSecretsService: () => undefined,
    stopOnClose: () => undefined,
  } as never);
}

afterEach(() => {
  vi.unstubAllEnvs();
  createClient.mockReset();
});

describe('the runner manager fetch', () => {
  it('is globalThis.fetch when no ID token audience is set', async () => {
    const wired = await wire({ RUNNER_MANAGER_URL: MANAGER, RUNNER_MANAGER_TOKEN: TOKEN });
    expect(wired.runnerManagerFetch).toBe(globalThis.fetch);
    expect(createClient.mock.calls[0]?.[2]).toBe(globalThis.fetch);
  });

  it('wraps fetch with the identity when RUNNER_MANAGER_ID_TOKEN_AUDIENCE is set', async () => {
    const wired = await wire({
      RUNNER_MANAGER_URL: MANAGER,
      RUNNER_MANAGER_TOKEN: TOKEN,
      RUNNER_MANAGER_ID_TOKEN_AUDIENCE: MANAGER,
    });
    expect(wired.runnerManagerFetch).not.toBe(globalThis.fetch);
    expect(createClient.mock.calls[0]?.[2]).toBe(wired.runnerManagerFetch);
  });

  it('leaves the manager unconfigured for a non-https audience', async () => {
    const wired = await wire({
      RUNNER_MANAGER_URL: MANAGER,
      RUNNER_MANAGER_TOKEN: TOKEN,
      RUNNER_MANAGER_ID_TOKEN_AUDIENCE: 'http://manager.internal',
    });
    expect(wired.runnerManager).toBeNull();
    expect(wired.runnerManagerFetch).toBe(globalThis.fetch);
  });
});
