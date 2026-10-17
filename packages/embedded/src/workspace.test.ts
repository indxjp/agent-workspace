import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prepareDatabase: vi.fn(),
  startGateway: vi.fn(),
  startRunner: vi.fn(),
  detectHostCapabilities: vi.fn(),
  startWeb: vi.fn(),
  startEmbeddedDatabase: vi.fn(),
  startDockerSandbox: vi.fn(),
  dockerGatewayHost: vi.fn(),
}));

vi.mock('@agent-workspace/core/db', () => ({
  prepareDatabase: mocks.prepareDatabase,
}));
vi.mock('@agent-workspace/gateway/start', () => ({ startGateway: mocks.startGateway }));
vi.mock('@agent-workspace/runner/start', () => ({ startRunner: mocks.startRunner }));
vi.mock('@indx-workspace/cli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@indx-workspace/cli')>()),
  detectHostCapabilities: mocks.detectHostCapabilities,
}));
vi.mock('@agent-workspace/web/server/start', () => ({ startWeb: mocks.startWeb }));
vi.mock('./docker-sandbox.js', () => ({
  startDockerSandbox: mocks.startDockerSandbox,
  dockerGatewayHost: mocks.dockerGatewayHost,
}));
vi.mock('./embedded-db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./embedded-db.js')>()),
  startEmbeddedDatabase: mocks.startEmbeddedDatabase,
}));

import {
  LOCAL_RUN_WORKSPACE_ROOT,
  loadDotEnv,
  runEmbeddedCommand,
  startWorkspace,
} from './workspace.js';

const environmentKeys = [
  'DATABASE_URL',
  'AW_DATABASE_PORT',
  'PORT',
  'GATEWAY_PORT',
  'RUNNER_PORT',
  'AW_DATA_DIR',
  'SESSION_SECRET',
  'MASTER_ENCRYPTION_KEY',
  'GATEWAY_TOKEN_SECRET',
  'AW_FILE_STORAGE_ROOT',
  'AW_SKILL_STORAGE_ROOT',
  'AW_SESSION_TRANSCRIPT_ROOT',
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

function createRunningService<T extends object>(details: T) {
  return { ...details, close: vi.fn().mockResolvedValue(undefined) };
}

describe('startWorkspace', () => {
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

  it('stops the embedded database when database preparation fails', async () => {
    const startupFailure = new Error('migration failed');
    const cleanupFailure = new Error('cleanup failed');
    const database = createRunningService({ url: 'postgresql://embedded' });
    database.close.mockRejectedValue(cleanupFailure);
    mocks.startEmbeddedDatabase.mockResolvedValue(database);
    mocks.prepareDatabase.mockRejectedValue(startupFailure);

    const failure = await startWorkspace().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([startupFailure, cleanupFailure]);

    expect(database.close).toHaveBeenCalledOnce();
    expect(mocks.startRunner).not.toHaveBeenCalled();
    for (const key of environmentKeys) expect(process.env[key]).toBeUndefined();
  });

  // #556: the embedded PostgreSQL's port can be moved off one the operating system reserves.
  it('starts the embedded database on the default port, or on AW_DATABASE_PORT', async () => {
    const startupFailure = new Error('migration failed');
    mocks.startEmbeddedDatabase.mockResolvedValue(
      createRunningService({ url: 'postgresql://embedded' }),
    );
    mocks.prepareDatabase.mockRejectedValue(startupFailure);

    await expect(startWorkspace()).rejects.toBe(startupFailure);
    expect(mocks.startEmbeddedDatabase).toHaveBeenLastCalledWith(undefined, 25_432);

    process.env['AW_DATABASE_PORT'] = '26000';
    await expect(startWorkspace()).rejects.toBe(startupFailure);
    expect(mocks.startEmbeddedDatabase).toHaveBeenLastCalledWith(undefined, 26_000);
  });

  it('refuses an invalid AW_DATABASE_PORT before anything starts', async () => {
    process.env['AW_DATABASE_PORT'] = '80';

    await expect(startWorkspace()).rejects.toMatchObject({
      name: 'EmbeddedDatabasePortError',
      code: 'invalid_port',
      message: 'AW_DATABASE_PORT must be a whole number from 1024 to 65535',
    });
    expect(mocks.startEmbeddedDatabase).not.toHaveBeenCalled();
    expect(mocks.prepareDatabase).not.toHaveBeenCalled();
    expect(mocks.startRunner).not.toHaveBeenCalled();
  });

  // Review of #556: a database port equal to the web port started PostgreSQL there, and the web
  // server failed about a minute later with a bare "port <n> is already in use".
  it('refuses an AW_DATABASE_PORT equal to the web port before anything starts', async () => {
    process.env['AW_DATABASE_PORT'] = '24100';
    process.env['PORT'] = '24100';

    await expect(startWorkspace()).rejects.toMatchObject({
      name: 'EmbeddedDatabasePortError',
      code: 'port_conflict',
      port: 24_100,
      message:
        "port 24100 is both the embedded PostgreSQL's port and PORT: set AW_DATABASE_PORT (or " +
        'PORT) in .env so the two differ',
    });
    expect(mocks.startEmbeddedDatabase).not.toHaveBeenCalled();
    expect(mocks.prepareDatabase).not.toHaveBeenCalled();
    expect(mocks.startRunner).not.toHaveBeenCalled();
  });

  it('ignores AW_DATABASE_PORT when DATABASE_URL names an external database', async () => {
    process.env['DATABASE_URL'] = 'postgresql://external';
    process.env['AW_DATABASE_PORT'] = 'not-a-port';
    const startupFailure = new Error('migration failed');
    mocks.prepareDatabase.mockRejectedValue(startupFailure);

    await expect(startWorkspace()).rejects.toBe(startupFailure);
    expect(mocks.startEmbeddedDatabase).not.toHaveBeenCalled();
  });

  it('restores generated environment before retrying a failed startup', async () => {
    const startupFailure = new Error('gateway unavailable');
    const firstDatabase = createRunningService({ url: 'postgresql://first' });
    const secondDatabase = createRunningService({ url: 'postgresql://second' });
    const firstRunner = createRunningService({ url: 'http://first-runner' });
    const secondRunner = createRunningService({ url: 'http://second-runner' });
    const gateway = createRunningService({ port: 4000 });
    const web = createRunningService({ url: 'http://web' });
    mocks.startEmbeddedDatabase
      .mockResolvedValueOnce(firstDatabase)
      .mockResolvedValueOnce(secondDatabase);
    mocks.startRunner.mockResolvedValueOnce(firstRunner).mockResolvedValueOnce(secondRunner);
    mocks.startGateway.mockRejectedValueOnce(startupFailure).mockResolvedValueOnce(gateway);
    mocks.startWeb.mockResolvedValue(web);

    await expect(startWorkspace()).rejects.toBe(startupFailure);
    expect(process.env['DATABASE_URL']).toBeUndefined();
    expect(process.env['RUNNER_URL']).toBeUndefined();
    expect(process.env['SESSION_SECRET']).toBeUndefined();

    const running = await startWorkspace();
    expect(mocks.startEmbeddedDatabase).toHaveBeenCalledTimes(2);
    expect(mocks.prepareDatabase).toHaveBeenLastCalledWith(
      expect.objectContaining({ DATABASE_URL: 'postgresql://second' }),
      { general: false },
    );
    await running.close();

    for (const key of environmentKeys) expect(process.env[key]).toBeUndefined();
  });

  it('releases every acquired resource when a later service fails to start', async () => {
    const startupFailure = new Error('gateway unavailable');
    const database = createRunningService({ url: 'postgresql://embedded' });
    const runner = createRunningService({ url: 'http://runner' });
    mocks.startEmbeddedDatabase.mockResolvedValue(database);
    mocks.startRunner.mockResolvedValue(runner);
    mocks.startGateway.mockRejectedValue(startupFailure);

    await expect(startWorkspace()).rejects.toBe(startupFailure);

    expect(runner.close).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it('attempts to stop every service even when one shutdown fails', async () => {
    const shutdownFailure = new Error('web shutdown failed');
    const database = createRunningService({ url: 'postgresql://embedded' });
    const runner = createRunningService({ url: 'http://runner' });
    const gateway = createRunningService({ port: 4000 });
    const web = createRunningService({ url: 'http://web' });
    web.close.mockRejectedValue(shutdownFailure);
    mocks.startEmbeddedDatabase.mockResolvedValue(database);
    mocks.startRunner.mockResolvedValue(runner);
    mocks.startGateway.mockResolvedValue(gateway);
    mocks.startWeb.mockResolvedValue(web);

    const running = await startWorkspace();
    await expect(running.close()).rejects.toBe(shutdownFailure);

    expect(web.close).toHaveBeenCalledOnce();
    expect(gateway.close).toHaveBeenCalledOnce();
    expect(runner.close).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it('restores the prior environment after a successful workspace closes', async () => {
    for (const key of environmentKeys) process.env[key] = `prior-${key}`;
    const priorEnvironment = Object.fromEntries(
      environmentKeys.map((key) => [key, process.env[key]]),
    );
    const runner = createRunningService({ url: 'http://runner' });
    const gateway = createRunningService({ port: 4000 });
    const web = createRunningService({ url: 'http://web' });
    mocks.startRunner.mockResolvedValue(runner);
    mocks.startGateway.mockResolvedValue(gateway);
    mocks.startWeb.mockResolvedValue(web);

    const running = await startWorkspace();
    expect(process.env['RUNNER_URL']).toBe('http://runner');
    expect(process.env['MODEL_GATEWAY_URL']).toBe('http://127.0.0.1:4000');
    await running.close();

    expect(Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]))).toEqual(
      priorEnvironment,
    );
  });

  it('returns the seed prepareDatabase settled on, for the launcher to sign its admin in', async () => {
    const seed = {
      workspaceId: '0b9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e',
      adminUserId: '1c9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e',
      generalAgentId: '2d9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e',
    };
    process.env['DATABASE_URL'] = 'postgresql://external';
    mocks.prepareDatabase.mockResolvedValue(seed);
    mocks.startRunner.mockResolvedValue(createRunningService({ url: 'http://runner' }));
    mocks.startGateway.mockResolvedValue(createRunningService({ port: 4000 }));
    mocks.startWeb.mockResolvedValue(createRunningService({ url: 'http://web' }));

    const running = await startWorkspace();
    expect(running.seed).toStrictEqual(seed);
    await running.close();
  });

  it('roots run workspaces under the project, not the container path /workspace (S1-19)', async () => {
    process.env['DATABASE_URL'] = 'postgresql://external';
    mocks.startRunner.mockResolvedValue(createRunningService({ url: 'http://runner' }));
    mocks.startGateway.mockResolvedValue(createRunningService({ port: 4000 }));
    mocks.startWeb.mockResolvedValue(createRunningService({ url: 'http://web' }));

    const running = await startWorkspace();
    const expected = path.resolve(LOCAL_RUN_WORKSPACE_ROOT);
    expect(path.isAbsolute(expected)).toBe(true);
    expect(process.env['RUNNER_WORKSPACE_ROOT']).toBe(expected);
    expect(mocks.startWeb).toHaveBeenCalledWith(
      expect.objectContaining({ RUNNER_WORKSPACE_ROOT: expected }),
      undefined,
    );
    await running.close();
    expect(process.env['RUNNER_WORKSPACE_ROOT']).toBeUndefined();
  });

  it('keeps a RUNNER_WORKSPACE_ROOT the environment already sets', async () => {
    process.env['DATABASE_URL'] = 'postgresql://external';
    process.env['RUNNER_WORKSPACE_ROOT'] = '/srv/runs';
    mocks.startRunner.mockResolvedValue(createRunningService({ url: 'http://runner' }));
    mocks.startGateway.mockResolvedValue(createRunningService({ port: 4000 }));
    mocks.startWeb.mockResolvedValue(createRunningService({ url: 'http://web' }));

    const running = await startWorkspace();
    expect(mocks.startWeb).toHaveBeenCalledWith(
      expect.objectContaining({ RUNNER_WORKSPACE_ROOT: '/srv/runs' }),
      undefined,
    );
    await running.close();
    expect(process.env['RUNNER_WORKSPACE_ROOT']).toBe('/srv/runs');
  });

  it('runs the web server as asked: the published build, or the contributor default', async () => {
    const web = createRunningService({ url: 'http://web' });
    mocks.startEmbeddedDatabase.mockResolvedValue(
      createRunningService({ url: 'postgresql://embedded' }),
    );
    mocks.startRunner.mockResolvedValue(createRunningService({ url: 'http://runner' }));
    mocks.startGateway.mockResolvedValue(createRunningService({ port: 4000 }));
    mocks.startWeb.mockResolvedValue(web);

    await (await startWorkspace({ web: { dir: '/runtime/dist/web', dev: false } })).close();
    expect(mocks.startWeb).toHaveBeenLastCalledWith(expect.any(Object), {
      dir: '/runtime/dist/web',
      dev: false,
    });

    await (await startWorkspace()).close();
    expect(mocks.startWeb).toHaveBeenLastCalledWith(expect.any(Object), undefined);
  });

  it('waits for network services before stopping the embedded database', async () => {
    let finishWebShutdown: (() => void) | undefined;
    const database = createRunningService({ url: 'postgresql://embedded' });
    const runner = createRunningService({ url: 'http://runner' });
    const gateway = createRunningService({ port: 4000 });
    const web = createRunningService({ url: 'http://web' });
    web.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishWebShutdown = resolve;
        }),
    );
    mocks.startEmbeddedDatabase.mockResolvedValue(database);
    mocks.startRunner.mockResolvedValue(runner);
    mocks.startGateway.mockResolvedValue(gateway);
    mocks.startWeb.mockResolvedValue(web);

    const running = await startWorkspace();
    const closing = running.close();
    await vi.waitFor(() => expect(web.close).toHaveBeenCalledOnce());
    expect(database.close).not.toHaveBeenCalled();

    finishWebShutdown?.();
    await closing;
    expect(database.close).toHaveBeenCalledOnce();
  });

  describe('runtime startup report', () => {
    const dockerAndLocal = [
      { id: 'docker', available: true, reason: 'Docker daemon is reachable' },
      {
        id: 'local',
        available: true,
        reason: 'No tenant isolation: commands run as the host user',
      },
    ];
    const isolationWarning = 'WARNING: local runtime has no tenant isolation';

    function resolveServices(): void {
      mocks.startEmbeddedDatabase.mockResolvedValue(
        createRunningService({ url: 'postgresql://embedded' }),
      );
      mocks.startRunner.mockResolvedValue(createRunningService({ url: 'http://runner' }));
      mocks.startGateway.mockResolvedValue(createRunningService({ port: 4000 }));
      mocks.startWeb.mockResolvedValue(createRunningService({ url: 'http://web' }));
    }

    function written(stream: NodeJS.WriteStream): string {
      return vi
        .mocked(stream)
        .write.mock.calls.map(([chunk]) => String(chunk))
        .join('');
    }

    it('reports the requested local driver and warns although the host prefers docker (#476)', async () => {
      process.env['RUNTIME_DRIVER'] = 'local';
      mocks.detectHostCapabilities.mockReturnValue({
        defaultDriver: 'docker',
        drivers: dockerAndLocal,
      });
      resolveServices();

      const running = await startWorkspace();
      await running.close();

      const stdout = written(process.stdout);
      expect(stdout).toContain(
        'Runtime: local — requested by RUNTIME_DRIVER; No tenant isolation: commands run as the host user\n',
      );
      expect(stdout).toContain('Host default: docker\n');
      expect(stdout).not.toContain('Runtime: docker');
      expect(written(process.stderr)).toContain(isolationWarning);
      expect(mocks.startRunner).toHaveBeenCalledWith(
        expect.objectContaining({ RUNTIME_DRIVER: 'local' }),
      );
    });

    it('runs a requested sandbox-runtime on local, says so once and warns (#818)', async () => {
      process.env['RUNTIME_DRIVER'] = 'sandbox-runtime';
      mocks.detectHostCapabilities.mockReturnValue({
        defaultDriver: 'docker',
        drivers: dockerAndLocal,
      });
      resolveServices();

      const running = await startWorkspace();
      await running.close();

      const notice =
        'sandbox-runtime is not implemented; this session runs on local with no isolation.\n';
      const stderr = written(process.stderr);
      expect(stderr.split(notice)).toHaveLength(2);
      expect(stderr).toContain(isolationWarning);
      expect(written(process.stdout)).toBe(
        'Runtime: local — No tenant isolation: commands run as the host user\n',
      );
      expect(mocks.startRunner).toHaveBeenCalledWith(
        expect.objectContaining({ RUNTIME_DRIVER: 'local' }),
      );
    });

    it('keeps the default line unchanged when RUNTIME_DRIVER is not set', async () => {
      mocks.detectHostCapabilities.mockReturnValue({
        defaultDriver: 'docker',
        drivers: dockerAndLocal,
      });
      resolveServices();

      const running = await startWorkspace();
      await running.close();

      expect(written(process.stdout)).toBe('Runtime: docker — Docker daemon is reachable\n');
      expect(written(process.stderr)).not.toContain(isolationWarning);
    });

    it('warns when the host default is local and RUNTIME_DRIVER is not set', async () => {
      mocks.detectHostCapabilities.mockReturnValue({
        defaultDriver: 'local',
        drivers: dockerAndLocal.slice(1),
      });
      resolveServices();

      const running = await startWorkspace();
      await running.close();

      expect(written(process.stdout)).toBe(
        'Runtime: local — No tenant isolation: commands run as the host user\n',
      );
      expect(written(process.stderr)).toContain(isolationWarning);
    });

    it('trims a padded RUNTIME_DRIVER, reports local and warns (#476)', async () => {
      process.env['RUNTIME_DRIVER'] = ' local\r';
      mocks.detectHostCapabilities.mockReturnValue({
        defaultDriver: 'docker',
        drivers: dockerAndLocal,
      });
      resolveServices();

      const running = await startWorkspace();
      await running.close();

      expect(written(process.stdout)).toBe(
        'Runtime: local — requested by RUNTIME_DRIVER; No tenant isolation: commands run as the host user\nHost default: docker\n',
      );
      expect(written(process.stderr)).toContain(isolationWarning);
      expect(mocks.startRunner).toHaveBeenCalledWith(
        expect.objectContaining({ RUNTIME_DRIVER: 'local' }),
      );
    });

    it('treats a blank RUNTIME_DRIVER as unset and reports the host default (#476)', async () => {
      process.env['RUNTIME_DRIVER'] = '  ';
      mocks.detectHostCapabilities.mockReturnValue({
        defaultDriver: 'docker',
        drivers: dockerAndLocal,
      });
      resolveServices();

      const running = await startWorkspace();
      await running.close();

      expect(written(process.stdout)).toBe('Runtime: docker — Docker daemon is reachable\n');
      expect(written(process.stderr)).not.toContain(isolationWarning);
      expect(mocks.startRunner).toHaveBeenCalledWith(
        expect.objectContaining({ RUNTIME_DRIVER: 'docker' }),
      );
    });

    it('treats an empty RUNTIME_DRIVER as unset and warns when the host default is local', async () => {
      process.env['RUNTIME_DRIVER'] = '';
      mocks.detectHostCapabilities.mockReturnValue({
        defaultDriver: 'local',
        drivers: dockerAndLocal.slice(1),
      });
      resolveServices();

      const running = await startWorkspace();
      await running.close();

      expect(written(process.stdout)).toBe(
        'Runtime: local — No tenant isolation: commands run as the host user\n',
      );
      expect(written(process.stderr)).toContain(isolationWarning);
    });

    it('reports a requested docker driver without a warning when the host prefers local', async () => {
      process.env['RUNTIME_DRIVER'] = 'docker';
      mocks.detectHostCapabilities.mockReturnValue({
        defaultDriver: 'local',
        drivers: dockerAndLocal,
      });
      resolveServices();
      const sandbox = createRunningService({
        url: 'http://127.0.0.1:41000',
        token: 't'.repeat(64),
      });
      mocks.startDockerSandbox.mockResolvedValue(sandbox);
      mocks.dockerGatewayHost.mockResolvedValue('172.17.0.1');

      const running = await startWorkspace();
      expect(written(process.stdout)).toBe(
        'Runtime: docker — requested by RUNTIME_DRIVER; Docker daemon is reachable\nHost default: local\n',
      );
      expect(written(process.stderr)).not.toContain(isolationWarning);
      // #786: runs go to the docker runner manager, and a sandbox reaches the gateway via the host.
      expect(mocks.startGateway).toHaveBeenCalledWith(
        expect.objectContaining({ HOST: '172.17.0.1' }),
      );
      expect(mocks.startWeb).toHaveBeenCalledWith(
        expect.objectContaining({
          RUNTIME_DRIVER: 'docker',
          RUNNER_MANAGER_URL: 'http://127.0.0.1:41000',
          RUNNER_MANAGER_TOKEN: 't'.repeat(64),
          RUNTIME_VERIFICATION_NETWORK_POLICY: 'open',
          MODEL_GATEWAY_URL: 'http://host.docker.internal:4000',
        }),
        undefined,
      );
      await running.close();
      expect(sandbox.close).toHaveBeenCalledOnce();
      expect(process.env['RUNNER_MANAGER_URL']).toBeUndefined();
    });

    it('fails the start, never falling back to local, when the docker sandbox cannot start (#786)', async () => {
      process.env['RUNTIME_DRIVER'] = 'docker';
      mocks.detectHostCapabilities.mockReturnValue({
        defaultDriver: 'docker',
        drivers: dockerAndLocal,
      });
      resolveServices();
      mocks.dockerGatewayHost.mockResolvedValue('127.0.0.1');
      const refused = new Error('the docker sandbox could not start and verify a container');
      mocks.startDockerSandbox.mockRejectedValue(refused);

      await expect(startWorkspace()).rejects.toBe(refused);
      expect(mocks.startRunner).not.toHaveBeenCalled();
      expect(mocks.startWeb).not.toHaveBeenCalled();
      expect(process.env['RUNTIME_DRIVER']).toBe('docker');
    });

    it('starts no docker sandbox for the local driver, nor for a docker host default nobody asked for', async () => {
      mocks.detectHostCapabilities.mockReturnValue({
        defaultDriver: 'docker',
        drivers: dockerAndLocal,
      });
      for (const requested of ['local', undefined]) {
        if (requested === undefined) delete process.env['RUNTIME_DRIVER'];
        else process.env['RUNTIME_DRIVER'] = requested;
        resolveServices();
        const running = await startWorkspace();
        await running.close();
        expect(mocks.startDockerSandbox).not.toHaveBeenCalled();
        expect(mocks.startGateway).toHaveBeenLastCalledWith(
          expect.objectContaining({ HOST: '127.0.0.1' }),
        );
        expect(mocks.startWeb.mock.lastCall?.[0]).not.toHaveProperty('RUNNER_MANAGER_URL');
      }
    });
  });
});

describe('runEmbeddedCommand contracts version check', () => {
  const stubFetch = (headers: Record<string, string>) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 401, headers }))),
    );
  const unsupported = {
    'x-agent-workspace-contracts': '99.1.0',
    'x-agent-workspace-contracts-minimum': '99.0.0',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stops an embedded workspace it refuses', async () => {
    const web = createRunningService({ url: 'http://web' });
    const database = createRunningService({ url: 'postgresql://embedded' });
    mocks.detectHostCapabilities.mockReturnValue({ defaultDriver: 'docker', drivers: [] });
    mocks.startEmbeddedDatabase.mockResolvedValue(database);
    mocks.startRunner.mockResolvedValue(createRunningService({ url: 'http://runner' }));
    mocks.startGateway.mockResolvedValue(createRunningService({ port: 4000 }));
    mocks.startWeb.mockResolvedValue(web);
    stubFetch(unsupported);
    await expect(runEmbeddedCommand()).rejects.toThrow(/serves contracts 99\.0\.0/);
    expect(web.close).toHaveBeenCalledOnce();
  });
});

describe('loadDotEnv', () => {
  let directory = '';

  beforeEach(() => {
    // The startWorkspace suite stubs process.loadEnvFile; this one needs the real one.
    vi.restoreAllMocks();
    directory = mkdtempSync(path.join(tmpdir(), 'embedded-dotenv-'));
  });

  afterEach(() => {
    delete process.env['AW_DOTENV_PROBE'];
    rmSync(directory, { recursive: true, force: true });
  });

  it('does nothing when the directory has no .env', () => {
    expect(() => {
      loadDotEnv(path.join(directory, '.env'));
    }).not.toThrow();
    expect(process.env['AW_DOTENV_PROBE']).toBeUndefined();
  });

  it('loads a .env that exists', () => {
    writeFileSync(path.join(directory, '.env'), 'AW_DOTENV_PROBE=loaded\n');
    loadDotEnv(path.join(directory, '.env'));
    expect(process.env['AW_DOTENV_PROBE']).toBe('loaded');
  });

  it('throws any failure other than a missing file', () => {
    mkdirSync(path.join(directory, '.env'));
    expect(() => {
      loadDotEnv(path.join(directory, '.env'));
    }).toThrow();
  });
});
