import { afterEach, beforeEach, vi, type Mock } from 'vitest';

const mocks: Record<
  | 'prepareDatabase'
  | 'startGateway'
  | 'startRunner'
  | 'detectHostCapabilities'
  | 'startWeb'
  | 'startEmbeddedDatabase'
  | 'startDockerSandbox'
  | 'dockerGatewayHost',
  Mock
> = {
  prepareDatabase: vi.fn(),
  startGateway: vi.fn(),
  startRunner: vi.fn(),
  detectHostCapabilities: vi.fn(),
  startWeb: vi.fn(),
  startEmbeddedDatabase: vi.fn(),
  startDockerSandbox: vi.fn(),
  dockerGatewayHost: vi.fn(),
};

/** Install the mocks before importing the subject, independent of import sorting. */
export async function loadWorkspaceTestServices() {
  vi.doMock('@agent-workspace/core/db', () => ({
    prepareDatabase: mocks.prepareDatabase,
  }));
  vi.doMock('@agent-workspace/gateway/start', () => ({ startGateway: mocks.startGateway }));
  vi.doMock('@agent-workspace/runner/start', () => ({ startRunner: mocks.startRunner }));
  vi.doMock('@indx-workspace/cli', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@indx-workspace/cli')>()),
    detectHostCapabilities: mocks.detectHostCapabilities,
  }));
  vi.doMock('@agent-workspace/web/server/start', () => ({ startWeb: mocks.startWeb }));
  vi.doMock('./docker-sandbox.js', () => ({
    startDockerSandbox: mocks.startDockerSandbox,
    dockerGatewayHost: mocks.dockerGatewayHost,
  }));
  vi.doMock('./embedded-db.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./embedded-db.js')>()),
    startEmbeddedDatabase: mocks.startEmbeddedDatabase,
  }));
  return import('./workspace.js');
}

export const environmentKeys = [
  'DATABASE_URL',
  'AW_DATABASE_PORT',
  'PORT',
  'GATEWAY_PORT',
  'RUNNER_PORT',
  'AW_DATA_DIR',
  'SESSION_SECRET',
  'MASTER_ENCRYPTION_KEY',
  'GATEWAY_TOKEN_SECRET',
  'AW_STORAGE_URL',
  'AW_FILE_STORAGE_ROOT',
  'OBJECT_STORAGE_BUCKET',
  'RUNNER_WORKSPACE_ROOT',
  'RUNTIME_DRIVER',
  'AW_SESSION_MIRROR_URL',
  'RUNNER_URL',
  'MODEL_GATEWAY_URL',
  'RUNNER_MANAGER_URL',
  'RUNNER_MANAGER_TOKEN',
  'RUNTIME_VERIFICATION_NETWORK_POLICY',
] as const;

const originalEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]]),
);

export function createRunningService<T extends object>(
  details: T,
): T & { close: Mock<() => Promise<void>> } {
  return { ...details, close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) };
}

export function installWorkspaceTestEnvironment() {
  beforeEach(() => {
    vi.resetAllMocks();
    for (const key of environmentKeys) delete process.env[key];
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    mocks.detectHostCapabilities.mockReturnValue({
      defaultDriver: 'docker',
      drivers: [{ id: 'docker', reason: 'available' }],
    });
    mocks.prepareDatabase.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const key of environmentKeys) {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });
}

export { mocks };
