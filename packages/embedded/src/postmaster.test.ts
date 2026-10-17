import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EmbeddedDatabaseError,
  locatePostgresBinary,
  type LocatePostgresDeps,
  postgresPlatformPackage,
  type PostmasterDeps,
  startPostmaster,
} from './postmaster.js';

const READY = 'LOG:  database system is ready to accept connections\n';

/** A spawned process: two pipes, `kill`, and the `exit` and `error` events. */
class FakeChild extends EventEmitter {
  readonly pid: number | undefined;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true);

  constructor(pid: number | undefined = 4242) {
    super();
    this.pid = pid;
  }

  exitWith(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: Record<string, unknown>;
}

function fakeDeps(overrides: Partial<PostmasterDeps> = {}) {
  const postmaster = new FakeChild();
  const taskkill = new FakeChild(5151);
  const calls: SpawnCall[] = [];
  const exitEvents = new EventEmitter();
  const kill = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
  const deps: PostmasterDeps = {
    spawn: (command, args, options) => {
      calls.push({ command, args, options: { ...options } });
      return calls.length === 1 ? postmaster : taskkill;
    },
    platform: 'linux',
    getuid: () => 1000,
    postgresIds: () => Promise.resolve({ uid: 70, gid: 70 }),
    kill,
    exitEvents,
    ...overrides,
  };
  return { deps, postmaster, taskkill, calls, exitEvents, kill };
}

const startOptions = (onLog: (message: string) => void = () => undefined) => ({
  binary: '/opt/pg/bin/postgres',
  dataDir: '/p/.agent-workspace/postgres',
  port: 25432,
  onLog,
});

/** Start against `fake`, then report it ready once the spawn happened. */
async function started(fake: ReturnType<typeof fakeDeps>) {
  const pending = startPostmaster(startOptions(), fake.deps);
  await vi.waitFor(() => {
    expect(fake.calls).toHaveLength(1);
  });
  fake.postmaster.stderr.write(READY);
  return pending;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('startPostmaster', () => {
  it('spawns the postmaster detached, in its own process group, with the C message locale', async () => {
    const fake = fakeDeps();
    const postmaster = await started(fake);

    expect(postmaster.pid).toBe(4242);
    const [call] = fake.calls;
    expect(call?.command).toBe('/opt/pg/bin/postgres');
    expect(call?.args).toStrictEqual(['-D', '/p/.agent-workspace/postgres', '-p', '25432']);
    expect(call?.options).toMatchObject({
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    expect(call?.options['env']).toMatchObject({ LC_MESSAGES: 'C' });
    expect(call?.options).not.toHaveProperty('uid');
    expect(call?.options).not.toHaveProperty('gid');
  });

  it('runs as the postgres user when the runtime is root', async () => {
    const fake = fakeDeps({ getuid: () => 0 });
    await started(fake);
    expect(fake.calls[0]?.options).toMatchObject({ uid: 70, gid: 70 });
  });

  it('refuses to run as root when there is no postgres user', async () => {
    const fake = fakeDeps({
      getuid: () => 0,
      postgresIds: () => Promise.reject(new Error('id: postgres: no such user')),
    });
    await expect(startPostmaster(startOptions(), fake.deps)).rejects.toMatchObject({
      code: 'root_without_postgres_user',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('forwards every chunk to onLog and is ready on the line even when it is split', async () => {
    const fake = fakeDeps();
    const logs: string[] = [];
    const pending = startPostmaster(
      startOptions((message) => logs.push(message)),
      fake.deps,
    );
    await vi.waitFor(() => {
      expect(fake.calls).toHaveLength(1);
    });
    fake.postmaster.stdout.write('starting\n');
    fake.postmaster.stderr.write('LOG:  database system is ready ');
    fake.postmaster.stderr.write('to accept connections\n');

    await expect(pending).resolves.toMatchObject({ pid: 4242 });
    expect(logs.join('')).toContain('starting');
  });

  it('rejects with postmaster_exited when the process exits before it is ready', async () => {
    const fake = fakeDeps();
    const pending = startPostmaster(startOptions(), fake.deps);
    await vi.waitFor(() => {
      expect(fake.calls).toHaveLength(1);
    });
    fake.postmaster.stderr.write('FATAL:  could not create any TCP/IP sockets\n');
    fake.postmaster.exitWith(1);

    const failure = await pending.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(EmbeddedDatabaseError);
    expect(failure).toMatchObject({
      code: 'postmaster_exited',
      message: 'the embedded PostgreSQL server exited before it was ready',
      cause: { code: 1, signal: null },
    });
    expect(fake.exitEvents.listenerCount('exit')).toBe(0);
  });

  it('rejects with windows_administrator when an elevated account starts it (BH061-003)', async () => {
    const fake = fakeDeps({ platform: 'win32', getuid: undefined });
    const pending = startPostmaster(startOptions(), fake.deps);
    await vi.waitFor(() => {
      expect(fake.calls).toHaveLength(1);
    });
    // The exit can be seen before the output that says why.
    fake.postmaster.exitWith(1);
    fake.postmaster.stderr.write('Execution of PostgreSQL by a user with administrative ');
    fake.postmaster.stderr.end('permissions is not permitted.\n');
    fake.postmaster.stdout.end();

    await expect(pending).rejects.toMatchObject({
      code: 'windows_administrator',
      message: expect.stringContaining('not elevated') as unknown,
    });
  });

  it('rejects with postmaster_exited when the binary cannot be spawned', async () => {
    const fake = fakeDeps();
    const pending = startPostmaster(startOptions(), fake.deps);
    await vi.waitFor(() => {
      expect(fake.calls).toHaveLength(1);
    });
    fake.postmaster.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await expect(pending).rejects.toMatchObject({ code: 'postmaster_exited' });
  });

  it('stops with SIGINT on POSIX and resolves on exit, once however often it is called', async () => {
    const fake = fakeDeps();
    const postmaster = await started(fake);

    const first = postmaster.stop();
    const second = postmaster.stop();
    expect(fake.postmaster.kill).toHaveBeenCalledExactlyOnceWith('SIGINT');
    fake.postmaster.exitWith(0);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(fake.calls).toHaveLength(1);
  });

  it('stops with taskkill on Windows', async () => {
    const fake = fakeDeps({ platform: 'win32' });
    const postmaster = await started(fake);

    const stopping = postmaster.stop();
    expect(fake.calls[1]).toMatchObject({
      command: 'taskkill',
      args: ['/pid', '4242', '/f', '/t'],
    });
    expect(fake.postmaster.kill).not.toHaveBeenCalled();
    fake.postmaster.exitWith(1);
    await expect(stopping).resolves.toBeUndefined();
  });

  it('resolves at once, signalling nothing, when the postmaster has already exited', async () => {
    const fake = fakeDeps();
    const postmaster = await started(fake);
    fake.postmaster.exitWith(0);

    await expect(postmaster.stop()).resolves.toBeUndefined();
    expect(fake.postmaster.kill).not.toHaveBeenCalled();
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it('kills the whole process group with SIGKILL when SIGINT does not stop it in time', async () => {
    const fake = fakeDeps({ stopTimeoutMs: 1_000, killGraceMs: 500 });
    const postmaster = await started(fake);
    vi.useFakeTimers();

    const stopping = postmaster.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.kill).toHaveBeenCalledExactlyOnceWith(-4242, 'SIGKILL');
    fake.postmaster.exitWith(null, 'SIGKILL');
    await expect(stopping).resolves.toBeUndefined();
  });

  it('rejects with stop_timeout when even SIGKILL does not end it', async () => {
    const fake = fakeDeps({ stopTimeoutMs: 1_000, killGraceMs: 500 });
    const postmaster = await started(fake);
    vi.useFakeTimers();

    const stopping = postmaster.stop();
    const outcome = stopping.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await outcome).toMatchObject({ code: 'stop_timeout' });
  });

  it('treats a process group that is already gone as stopped', async () => {
    const fake = fakeDeps({
      stopTimeoutMs: 1_000,
      kill: () => {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      },
    });
    const postmaster = await started(fake);
    vi.useFakeTimers();

    const stopping = postmaster.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(stopping).resolves.toBeUndefined();
  });

  it('registers an exit backstop that SIGINTs a running postmaster, and stop removes it', async () => {
    const fake = fakeDeps();
    const postmaster = await started(fake);
    expect(fake.exitEvents.listenerCount('exit')).toBe(1);

    fake.exitEvents.emit('exit');
    expect(fake.postmaster.kill).toHaveBeenCalledExactlyOnceWith('SIGINT');

    const again = fakeDeps();
    const stopped = await started(again);
    const stopping = stopped.stop();
    expect(again.exitEvents.listenerCount('exit')).toBe(0);
    again.postmaster.exitWith(0);
    await stopping;
    fake.postmaster.exitWith(null, 'SIGINT');
    await expect(postmaster.stop()).resolves.toBeUndefined();
  });

  it('never throws from the backstop, even when kill does', async () => {
    const fake = fakeDeps();
    await started(fake);
    fake.postmaster.kill.mockImplementation(() => {
      throw new Error('kill EPERM');
    });
    expect(() => fake.exitEvents.emit('exit')).not.toThrow();
  });
});

describe('postgresPlatformPackage', () => {
  it('mirrors the platform table of embedded-postgres', () => {
    const table: readonly (readonly [NodeJS.Platform, string, RegExp])[] = [
      ['darwin', 'arm64', /^@embedded-postgres\/darwin-arm64$/u],
      ['darwin', 'x64', /^@embedded-postgres\/darwin-x64$/u],
      ['linux', 'arm64', /^@embedded-postgres\/linux-arm64$/u],
      ['linux', 'arm', /^@embedded-postgres\/linux-arm$/u],
      ['linux', 'ia32', /^@embedded-postgres\/linux-ia32$/u],
      ['linux', 'ppc64', /^@embedded-postgres\/linux-ppc64$/u],
      ['linux', 'x64', /^@embedded-postgres\/linux-x64$/u],
      ['win32', 'x64', /^@embedded-postgres\/windows-x64$/u],
    ];
    for (const [platform, arch, expected] of table) {
      expect(postgresPlatformPackage(platform, arch)).toMatch(expected);
    }
  });

  it('refuses any other platform or architecture with unsupported_platform', () => {
    for (const [platform, arch] of [
      ['win32', 'arm64'],
      ['freebsd', 'x64'],
      ['linux', 's390x'],
    ] as const) {
      expect(() => postgresPlatformPackage(platform, arch)).toThrow(
        expect.objectContaining({ code: 'unsupported_platform' }),
      );
    }
  });
});

describe('locatePostgresBinary', () => {
  const libraryManifest = path.join('/store', 'library', 'package.json');
  const platformManifest = path.join('/store', 'linux-x64', 'package.json');
  const binary = path.join('/store', 'linux-x64', 'native', 'bin', 'postgres');

  function locateDeps(overrides: Partial<LocatePostgresDeps> = {}) {
    const lookups: { readonly specifier: string; readonly base: string }[] = [];
    const chmod = vi.fn<(file: string, mode: number) => void>();
    const deps: LocatePostgresDeps = {
      findPackageJSON: (specifier, base) => {
        lookups.push({ specifier, base: String(base) });
        return lookups.length === 1 ? libraryManifest : platformManifest;
      },
      platform: 'linux',
      arch: 'x64',
      realpath: (file) => file,
      fileMode: () => 0o100755,
      chmod,
      ...overrides,
    };
    return { deps, lookups, chmod };
  }

  it('finds the binary through the platform package embedded-postgres depends on', () => {
    const { deps, lookups, chmod } = locateDeps();
    expect(locatePostgresBinary(deps)).toBe(binary);
    expect(lookups[0]?.specifier).toMatch(/^embedded-postgres$/u);
    expect(lookups[1]?.specifier).toMatch(/^@embedded-postgres\/linux-x64$/u);
    // From embedded-postgres's own manifest, so pnpm's strict layout resolves it.
    expect(lookups[1]?.base).toMatch(/^file:.*package\.json$/u);
    expect(chmod).not.toHaveBeenCalled();
  });

  it('adds the r-x bits a binary is missing, as embedded-postgres does', () => {
    const { deps, chmod } = locateDeps({ fileMode: () => 0o100644 });
    locatePostgresBinary(deps);
    expect(chmod).toHaveBeenCalledExactlyOnceWith(binary, 0o100755 | 0o100644);
  });

  it('names postgres.exe on Windows and leaves its mode alone', () => {
    const { deps, chmod } = locateDeps({ platform: 'win32', fileMode: () => 0o100644 });
    expect(path.basename(locatePostgresBinary(deps))).toMatch(/^postgres\.exe$/u);
    expect(chmod).not.toHaveBeenCalled();
  });

  it('is binary_not_found when a package or the file is missing', () => {
    const missingLibrary = locateDeps({ findPackageJSON: () => undefined });
    expect(() => locatePostgresBinary(missingLibrary.deps)).toThrow(
      expect.objectContaining({ code: 'binary_not_found' }),
    );
    const unresolvable = locateDeps({
      findPackageJSON: () => {
        throw Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' });
      },
    });
    expect(() => locatePostgresBinary(unresolvable.deps)).toThrow(
      expect.objectContaining({ code: 'binary_not_found' }),
    );
    const missingFile = locateDeps({
      fileMode: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    });
    expect(() => locatePostgresBinary(missingFile.deps)).toThrow(
      expect.objectContaining({ code: 'binary_not_found' }),
    );
  });

  it('finds the real binary of this install', () => {
    const located = locatePostgresBinary();
    expect(path.isAbsolute(located)).toBe(true);
  });
});
