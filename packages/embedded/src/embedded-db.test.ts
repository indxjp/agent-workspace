import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Postmaster, StartPostmasterOptions } from './postmaster.js';

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  /** The data directory's files, by base name: `PG_VERSION`, `postmaster.pid`. */
  files: new Map<string, string>(),
  /** The injected `startPostmaster`; each call is one start attempt. */
  start: vi.fn<(options: StartPostmasterOptions) => Promise<Postmaster>>(),
  stop: vi.fn<() => Promise<void>>(),
  initialise: vi.fn(),
  /** `embedded-postgres`'s own `start()`, which must never be called. */
  libraryStart: vi.fn(),
  /** The options each mocked `EmbeddedPostgres` was constructed with. */
  options: [] as unknown[],
}));

vi.mock('node:fs/promises', () => ({
  mkdir: mocks.mkdir,
  readFile: (file: string) => {
    const text = mocks.files.get(file.split(/[\\/]/u).at(-1) ?? '');
    return text === undefined
      ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      : Promise.resolve(text);
  },
}));
vi.mock('embedded-postgres', () => ({
  default: class MockEmbeddedPostgres {
    constructor(options: unknown) {
      mocks.options.push(options);
    }

    initialise = mocks.initialise;
    start = mocks.libraryStart;
  },
}));

import {
  EMBEDDED_DATABASE_PORT,
  type EmbeddedDatabaseOptions,
  EmbeddedDatabasePortError,
  EmbeddedDatabasePortInUseError,
  type LoopbackListenerState,
  loopbackPortState,
  probeLoopbackListener,
  probeLoopbackPort,
  resolveEmbeddedDatabasePort,
  startEmbeddedDatabase,
} from './embedded-db.js';
import { EmbeddedDatabaseError } from './postmaster.js';

/**
 * Seams that find every port free, locate a fixed binary and start the mocked postmaster, so these
 * tests never touch a real socket or process.
 */
const seams: EmbeddedDatabaseOptions = {
  probePort: () => Promise.resolve(),
  locatePostgres: () => '/opt/pg/bin/postgres',
  startPostmaster: (options) => mocks.start(options),
};

function addressInUse(): Error {
  return Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
}

/** What a bind into a Windows excluded port range answers. */
function accessDenied(): Error {
  return Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
}

const IN_USE_MESSAGE =
  `port ${String(EMBEDDED_DATABASE_PORT)} is already in use: another process holds it (for ` +
  "example another project's aw dev, or a PostgreSQL a killed run left behind); stop it, or set " +
  'AW_DATABASE_PORT in .env to another free port below 49152';

/** Hold a loopback port with a listening server; resolves with the server and its port. */
async function holdLoopbackPort(): Promise<{
  readonly server: ReturnType<typeof createServer>;
  readonly port: number;
}> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { server, port: address.port };
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

/** What `startPostmaster` rejects with when the postmaster exits before it is ready. */
function exitedBeforeReady(): EmbeddedDatabaseError {
  return new EmbeddedDatabaseError('postmaster_exited', { cause: { code: 1, signal: null } });
}

describe('startEmbeddedDatabase', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.options.length = 0;
    mocks.files.clear();
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.stop.mockResolvedValue(undefined);
    mocks.start.mockResolvedValue({ pid: 4242, stop: mocks.stop });
    mocks.initialise.mockResolvedValue(undefined);
  });

  it('starts a persistent database and exposes a stoppable local URL', async () => {
    const database = await startEmbeddedDatabase('C:/workspace/postgres', 55432, seams);

    expect(database.url).toBe(
      'postgresql://agent_workspace:agent_workspace_local@127.0.0.1:55432/postgres',
    );
    expect(mocks.mkdir).toHaveBeenCalledWith('C:/workspace/postgres', { recursive: true });
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        binary: '/opt/pg/bin/postgres',
        dataDir: 'C:/workspace/postgres',
        port: 55432,
      }),
    );
    // An initialised directory never reaches embedded-postgres.
    expect(mocks.options).toHaveLength(0);

    await database.close();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it('initialises an empty database through embedded-postgres after the first start attempt fails', async () => {
    mocks.start.mockRejectedValueOnce(exitedBeforeReady());

    await expect(
      startEmbeddedDatabase('C:/workspace/postgres', undefined, seams),
    ).resolves.toBeDefined();

    expect(mocks.initialise).toHaveBeenCalledOnce();
    expect(mocks.options).toStrictEqual([
      expect.objectContaining({
        databaseDir: 'C:/workspace/postgres',
        port: EMBEDDED_DATABASE_PORT,
        user: 'agent_workspace',
        persistent: true,
      }),
    ]);
    expect(mocks.start).toHaveBeenCalledTimes(2);
    // The library's own `start()` would spawn the postmaster in the launcher's process group.
    expect(mocks.libraryStart).not.toHaveBeenCalled();
  });

  it('preserves an initialisation failure, with no postmaster left to stop', async () => {
    const initialisationFailure = new Error('initialisation failed');
    mocks.start.mockRejectedValueOnce(exitedBeforeReady());
    mocks.initialise.mockRejectedValue(initialisationFailure);

    await expect(startEmbeddedDatabase('C:/workspace/postgres', undefined, seams)).rejects.toBe(
      initialisationFailure,
    );

    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  // initdb on an initialised cluster advises emptying the directory, which deletes the local data.
  it('names a live postmaster a killed run left on the data directory, without running initdb', async () => {
    mocks.files.set('PG_VERSION', '16\n');
    mocks.files.set('postmaster.pid', `${String(process.pid)}\n/data\n`);
    mocks.start.mockRejectedValueOnce(exitedBeforeReady());

    await expect(
      startEmbeddedDatabase('C:/workspace/postgres', undefined, seams),
    ).rejects.toMatchObject({ code: 'data_directory_in_use' });

    expect(mocks.initialise).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it('reports an initialised cluster that will not start as is, without running initdb', async () => {
    mocks.files.set('PG_VERSION', '16\n');
    const failure = exitedBeforeReady();
    mocks.start.mockRejectedValueOnce(failure);

    await expect(startEmbeddedDatabase('C:/workspace/postgres', undefined, seams)).rejects.toBe(
      failure,
    );

    expect(mocks.initialise).not.toHaveBeenCalled();
  });

  // A typed failure to start the postmaster at all is the reason; running initdb after it only
  // replaced it with embedded-postgres's own untyped error (review of #510).
  it.each(['root_without_postgres_user', 'binary_not_found', 'unsupported_platform'] as const)(
    'reports %s from the start itself, without running initdb',
    async (code) => {
      const failure = new EmbeddedDatabaseError(code);
      mocks.start.mockRejectedValueOnce(failure);

      await expect(startEmbeddedDatabase('C:/workspace/postgres', undefined, seams)).rejects.toBe(
        failure,
      );

      expect(mocks.initialise).not.toHaveBeenCalled();
      expect(mocks.start).toHaveBeenCalledOnce();
    },
  );

  it('refuses before anything starts when the server binary cannot be found', async () => {
    const missing = new EmbeddedDatabaseError('binary_not_found');
    await expect(
      startEmbeddedDatabase('C:/workspace/postgres', undefined, {
        ...seams,
        locatePostgres: () => {
          throw missing;
        },
      }),
    ).rejects.toBe(missing);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('refuses a port the probe finds in use before starting anything', async () => {
    const failure = startEmbeddedDatabase('C:/workspace/postgres', undefined, {
      ...seams,
      probePort: () => Promise.reject(addressInUse()),
      probeListener: () => Promise.resolve('listening'),
    });

    await expect(failure).rejects.toBeInstanceOf(EmbeddedDatabasePortInUseError);
    await expect(failure).rejects.toMatchObject({
      code: 'EADDRINUSE',
      port: EMBEDDED_DATABASE_PORT,
      message: IN_USE_MESSAGE,
    });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.mkdir).not.toHaveBeenCalled();
  });

  // #556: under WSL2 mirrored networking a port in Windows' dynamic range answers EADDRINUSE (or,
  // in an excluded range, EACCES) although nothing listens; it was reported as "already in use".
  it.each([
    ['EADDRINUSE', addressInUse],
    ['EACCES', accessDenied],
  ] as const)(
    'reports a port the OS reserves (%s, nothing listening) as port_reserved',
    async (_code, bindError) => {
      const locatePostgres = vi.fn(() => '/opt/pg/bin/postgres');
      const probeListener = vi.fn(() => Promise.resolve<LoopbackListenerState>('none'));
      const failure = startEmbeddedDatabase('C:/workspace/postgres', undefined, {
        ...seams,
        locatePostgres,
        probePort: () => Promise.reject(bindError()),
        probeListener,
      });

      await expect(failure).rejects.toBeInstanceOf(EmbeddedDatabasePortError);
      await expect(failure).rejects.toMatchObject({
        code: 'port_reserved',
        port: EMBEDDED_DATABASE_PORT,
      });
      const error: unknown = await failure.catch((caught: unknown) => caught);
      if (!(error instanceof EmbeddedDatabasePortError)) throw new Error('not a port error');
      expect(error.message).toContain(`port ${String(EMBEDDED_DATABASE_PORT)} cannot be bound`);
      expect(error.message).toContain('AW_DATABASE_PORT');
      expect(error.message).toContain('DATABASE_URL');
      // Not an EADDRINUSE error, so the launcher does not collapse it into "already in use".
      expect(error.code).toBe('port_reserved');
      expect(probeListener).toHaveBeenCalledExactlyOnceWith(EMBEDDED_DATABASE_PORT);
      expect(locatePostgres).not.toHaveBeenCalled();
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.mkdir).not.toHaveBeenCalled();
    },
  );

  // A port a run just closed can refuse a bind for a moment with nothing listening (BH061-063).
  it('starts on a port whose refused bind with nothing listening clears on the recheck', async () => {
    const probePort = vi
      .fn<(port: number) => Promise<void>>()
      .mockRejectedValueOnce(addressInUse())
      .mockResolvedValue(undefined);
    await expect(
      startEmbeddedDatabase('C:/workspace/postgres', undefined, {
        ...seams,
        probePort,
        probeListener: () => Promise.resolve('none'),
      }),
    ).resolves.toBeDefined();
    expect(probePort).toHaveBeenCalledTimes(2);
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it.each([
    ['EADDRINUSE', addressInUse],
    ['EACCES', accessDenied],
  ] as const)('reports %s with a listening process as in use', async (_code, bindError) => {
    const failure = startEmbeddedDatabase('C:/workspace/postgres', undefined, {
      ...seams,
      probePort: () => Promise.reject(bindError()),
      probeListener: () => Promise.resolve('listening'),
    });

    await expect(failure).rejects.toBeInstanceOf(EmbeddedDatabasePortInUseError);
    await expect(failure).rejects.toMatchObject({ message: IN_USE_MESSAGE });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  // An inconclusive listener check (a timeout, or a connect error other than ECONNREFUSED) must
  // not claim that a process holds the port: it names both causes and both remedies.
  it.each([
    ['EADDRINUSE', addressInUse],
    ['EACCES', accessDenied],
  ] as const)(
    'reports %s with an inconclusive listener check as port_unavailable',
    async (_code, bindError) => {
      const failure = startEmbeddedDatabase('C:/workspace/postgres', undefined, {
        ...seams,
        probePort: () => Promise.reject(bindError()),
        probeListener: () => Promise.resolve<LoopbackListenerState>('unknown'),
      });

      await expect(failure).rejects.toBeInstanceOf(EmbeddedDatabasePortError);
      await expect(failure).rejects.toMatchObject({
        code: 'port_unavailable',
        port: EMBEDDED_DATABASE_PORT,
        message:
          `port ${String(EMBEDDED_DATABASE_PORT)} cannot be bound on 127.0.0.1, and whether a ` +
          'process holds it could not be determined: another process holds it or the operating ' +
          'system reserves it; stop whatever holds it, or set AW_DATABASE_PORT in .env to a free ' +
          'port below 49152, or DATABASE_URL to your own PostgreSQL',
      });
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.mkdir).not.toHaveBeenCalled();
    },
  );

  it('rethrows any other probe failure without asking for a listener', async () => {
    const other = Object.assign(new Error('listen EINVAL'), { code: 'EINVAL' });
    const probeListener = vi.fn(() => Promise.resolve<LoopbackListenerState>('none'));

    await expect(
      startEmbeddedDatabase('C:/workspace/postgres', undefined, {
        ...seams,
        probePort: () => Promise.reject(other),
        probeListener,
      }),
    ).rejects.toBe(other);
    expect(probeListener).not.toHaveBeenCalled();
  });

  it('finds a port another listener holds with the real probe', async () => {
    const { server, port } = await holdLoopbackPort();
    try {
      await expect(probeLoopbackPort(port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await closeServer(server);
    }
  });

  it('reports a held port as in use with the real probes', async () => {
    const { server, port } = await holdLoopbackPort();
    try {
      await expect(
        startEmbeddedDatabase('C:/workspace/postgres', port, {
          locatePostgres: () => '/opt/pg/bin/postgres',
          startPostmaster: (options) => mocks.start(options),
        }),
      ).rejects.toBeInstanceOf(EmbeddedDatabasePortInUseError);
    } finally {
      await closeServer(server);
    }
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('reports the port when the postmaster logs that it cannot bind, without re-initialising', async () => {
    mocks.start.mockImplementationOnce(({ onLog }) => {
      onLog('FATAL:  could not create any TCP/IP sockets');
      return Promise.reject(exitedBeforeReady());
    });

    await expect(
      startEmbeddedDatabase('C:/workspace/postgres', 55432, seams),
    ).rejects.toMatchObject({ code: 'EADDRINUSE', port: 55432 });
    expect(mocks.initialise).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it('reports the port when the bind fails on the start after initialising', async () => {
    mocks.start.mockRejectedValueOnce(exitedBeforeReady());
    mocks.start.mockImplementationOnce(({ onLog }) => {
      onLog('LOG:  could not bind IPv4 address "127.0.0.1": Address already in use');
      return Promise.reject(exitedBeforeReady());
    });

    await expect(
      startEmbeddedDatabase('C:/workspace/postgres', 55432, seams),
    ).rejects.toMatchObject({ code: 'EADDRINUSE', port: 55432 });
  });

  /**
   * `embedded-postgres`'s `stop()` waited for an `exit` event that never came once the postmaster
   * had already exited, which is what a failed bind leaves behind: the runtime hung for good. A
   * failed start now stops nothing, because `startPostmaster` rejects only once the process ended.
   */
  it('settles a failed start without waiting on any stop', async () => {
    const failure = exitedBeforeReady();
    mocks.start.mockRejectedValue(failure);
    mocks.stop.mockReturnValue(new Promise<void>(() => undefined));

    await expect(startEmbeddedDatabase('C:/workspace/postgres', 55432, seams)).rejects.toBe(
      failure,
    );
    expect(mocks.stop).not.toHaveBeenCalled();
  }, 15_000);

  /**
   * `embedded-postgres` depends on `async-exit-hook`, which on first use registers a `beforeExit`
   * listener that calls `process.exit(0)` on the next tick. Importing it at module scope therefore
   * discards every non-zero `process.exitCode` set anywhere in the process — and `index.ts`
   * re-exports `startWorkspace`, so the `agent-workspace` binary reached this file on every
   * invocation: `validate` printed its refusal and then exited 0. The import has to stay inside
   * the function that initialises a database (and `postmaster.ts`, which this file imports, must
   * not import it either), and this is what holds it there.
   *
   * Spawned rather than asserted in-process, because what is being proved is a property of the
   * process: that a module Node has finished evaluating left the exit code alone.
   */
  it('does not install a process-wide exit hook merely by being imported', () => {
    const module = new URL('./embedded-db.ts', import.meta.url).href;

    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(module)});\nprocess.exitCode = 3;\n`,
      ],
      { encoding: 'utf8' },
    );

    // 3 rather than 1, so a module that simply failed to load cannot be mistaken for a pass.
    expect(result.status, result.stderr).toBe(3);
  }, 20_000);
});

describe('probeLoopbackListener', () => {
  it('answers listening for a port a server holds, and none once it is freed', async () => {
    const { server, port } = await holdLoopbackPort();
    try {
      await expect(probeLoopbackListener(port)).resolves.toBe('listening');
    } finally {
      await closeServer(server);
    }
    await expect(probeLoopbackListener(port)).resolves.toBe('none');
  });
});

describe('loopbackPortState', () => {
  it('answers listening for a port a server holds, and free once it is freed', async () => {
    const { server, port } = await holdLoopbackPort();
    try {
      await expect(loopbackPortState(port)).resolves.toBe('listening');
    } finally {
      await closeServer(server);
    }
    await expect(loopbackPortState(port)).resolves.toBe('free');
  });
});

describe('resolveEmbeddedDatabasePort', () => {
  it('defaults to a port outside every ephemeral range (#556)', () => {
    expect(EMBEDDED_DATABASE_PORT).toBe(25432);
    // Linux's default ephemeral range starts at 32768; Windows' and macOS' at 49152.
    expect(EMBEDDED_DATABASE_PORT).toBeLessThan(32_768);
    expect(EMBEDDED_DATABASE_PORT).toBeGreaterThanOrEqual(1024);
  });

  it.each([{}, { AW_DATABASE_PORT: '' }, { AW_DATABASE_PORT: '   ' }])(
    'uses the default when AW_DATABASE_PORT is unset or blank (%j)',
    (env) => {
      expect(resolveEmbeddedDatabasePort(env)).toBe(EMBEDDED_DATABASE_PORT);
    },
  );

  it.each([
    ['26000', 26_000],
    ['1024', 1024],
    ['65535', 65_535],
  ])('accepts AW_DATABASE_PORT=%s', (value, port) => {
    expect(resolveEmbeddedDatabasePort({ AW_DATABASE_PORT: value })).toBe(port);
  });

  it.each(['0', '80', '1023', '65536', '70000', '12a', ' 1', '1e4', '-1', '123456', '2.5'])(
    'refuses AW_DATABASE_PORT=%j without echoing it',
    (value) => {
      let caught: unknown;
      try {
        resolveEmbeddedDatabasePort({ AW_DATABASE_PORT: value });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EmbeddedDatabasePortError);
      expect(caught).toMatchObject({
        code: 'invalid_port',
        port: undefined,
        message: 'AW_DATABASE_PORT must be a whole number from 1024 to 65535',
      });
    },
  );

  // A database port equal to a service port used to start PostgreSQL on it, and the service then
  // failed about a minute later with a bare "port <n> is already in use".
  it.each([
    [{ AW_DATABASE_PORT: '3000' }, 3000, 'PORT'],
    [{ AW_DATABASE_PORT: '24100', PORT: '24100' }, 24_100, 'PORT'],
    [{ AW_DATABASE_PORT: '4000' }, 4000, 'GATEWAY_PORT'],
    [{ AW_DATABASE_PORT: '24101', GATEWAY_PORT: ' 24101 ' }, 24_101, 'GATEWAY_PORT'],
    [{ AW_DATABASE_PORT: '8080' }, 8080, 'RUNNER_PORT'],
    [{ RUNNER_PORT: String(EMBEDDED_DATABASE_PORT) }, EMBEDDED_DATABASE_PORT, 'RUNNER_PORT'],
  ] as const)('refuses %j (port %s) as a clash with %s', (env, port, variable) => {
    let caught: unknown;
    try {
      resolveEmbeddedDatabasePort(env);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EmbeddedDatabasePortError);
    expect(caught).toMatchObject({
      code: 'port_conflict',
      port,
      message:
        `port ${String(port)} is both the embedded PostgreSQL's port and ${variable}: set ` +
        `AW_DATABASE_PORT (or ${variable}) in .env so the two differ`,
    });
  });

  it.each([
    { AW_DATABASE_PORT: '3000', PORT: '3100' },
    { AW_DATABASE_PORT: '26000', PORT: '3000', GATEWAY_PORT: '4000', RUNNER_PORT: '8080' },
    { PORT: 'not-a-port' },
  ])('accepts a database port that differs from every service port (%j)', (env) => {
    expect(() => resolveEmbeddedDatabasePort(env)).not.toThrow();
  });
});
