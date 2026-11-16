/**
 * S1-25 (#510, ADR-0112): the embedded PostgreSQL postmaster, started by the local runtime itself.
 *
 * `embedded-postgres` spawns the postmaster without `detached`, so it stays in the launcher's
 * foreground process group. A terminal's Ctrl+C sends SIGINT to that whole group, and the postmaster
 * fast-shut-down while the launcher was still revoking its credential: the revoke failed and every
 * idle pool connection died with `57P01`. S1-06's `claimSignals` only removed the library's
 * in-process exit hook; it could not keep the terminal's signal away from the child.
 *
 * So the runtime spawns the postmaster here, `detached`: on POSIX that is `setsid()`, its own session
 * and process group, and on Windows a new process group with no console, so no console Ctrl+C. A
 * terminal's SIGINT then reaches only the launcher, which revokes the credential, closes the server
 * and only then stops the postmaster through {@link Postmaster.stop}. `embedded-postgres` is still
 * the owner of the platform binaries and still runs `initdb` on a first start, but its `start()` is
 * never called, so its exit hook has no process to stop.
 *
 * The launcher stops it in order on SIGINT, SIGTERM, SIGHUP and SIGBREAK too (`launcher-signals.ts`):
 * no terminal or console signal reaches a detached postmaster. An exit through `process.exit`, an
 * uncaught exception or an empty event loop runs the `exit` backstop, which sends it SIGINT. A
 * launcher killed with SIGKILL, or by another signal's default action, runs no code, so it leaves
 * the postmaster running; the next start then reports the port in use until it is stopped.
 *
 * A Windows account with administrator rights cannot run `postgres.exe` directly (#892). There the
 * postmaster is started through the bundled `pg_ctl.exe`, which drops those rights the way
 * PostgreSQL's own tooling does; see `startThroughPgCtl`.
 */
import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { chmodSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The PostgreSQL major version of the pinned `embedded-postgres` (`PG_VERSION` of a data directory
 * it initialised). A data directory of another major cannot be opened by this server.
 */
export const EMBEDDED_POSTGRES_MAJOR = '18';

export type EmbeddedDatabaseErrorCode =
  | 'unsupported_platform'
  | 'binary_not_found'
  | 'root_without_postgres_user'
  | 'windows_administrator'
  | 'postmaster_exited'
  | 'data_directory_in_use'
  | 'data_directory_version'
  | 'stop_timeout';

const EMBEDDED_DATABASE_MESSAGES: Readonly<Record<EmbeddedDatabaseErrorCode, string>> = {
  unsupported_platform:
    'the embedded PostgreSQL has no server binary for this platform and architecture',
  binary_not_found:
    'the embedded PostgreSQL server binary could not be found; reinstall the local runtime',
  root_without_postgres_user:
    'PostgreSQL cannot run as root, and no postgres user was found to run it as',
  windows_administrator:
    'the embedded PostgreSQL refuses to run from a Windows account with administrator rights, even ' +
    'through pg_ctl; run aw dev from a terminal that is not elevated (not "Run as administrator") ' +
    'or under WSL, or set DATABASE_URL to an existing PostgreSQL',
  postmaster_exited: 'the embedded PostgreSQL server exited before it was ready',
  data_directory_in_use:
    'the local data directory is still used by a PostgreSQL that an earlier, killed run left ' +
    'behind (its process id is the first line of postmaster.pid in that directory): stop that ' +
    'process, then start again. Do not empty the directory: it holds your local data',
  data_directory_version:
    'the local data directory was created by another PostgreSQL major version than the ' +
    `PostgreSQL ${EMBEDDED_POSTGRES_MAJOR} this local runtime runs, which cannot open it, and ` +
    'nothing in it was changed. To keep its data, export it with the release that created it ' +
    '("Upgrade the local database" in the aw dev docs); to start with an empty database, move the ' +
    'directory (AW_DATA_DIR, or .agent-workspace/postgres) aside',
  stop_timeout: 'the embedded PostgreSQL server did not stop in time',
};

/** The embedded PostgreSQL could not be found, started or stopped. The message names no path. */
export class EmbeddedDatabaseError extends Error {
  readonly code: EmbeddedDatabaseErrorCode;

  constructor(code: EmbeddedDatabaseErrorCode, options?: { readonly cause: unknown }) {
    super(EMBEDDED_DATABASE_MESSAGES[code], options);
    this.name = 'EmbeddedDatabaseError';
    this.code = code;
  }
}

/**
 * The platform package `embedded-postgres` takes its binaries from, per `os.platform()` and
 * `os.arch()`: the table of `embedded-postgres/dist/binary.js` at the pinned version.
 */
const PLATFORM_PACKAGES: Readonly<
  Partial<Record<NodeJS.Platform, Readonly<Record<string, string>>>>
> = {
  darwin: { arm64: '@embedded-postgres/darwin-arm64', x64: '@embedded-postgres/darwin-x64' },
  linux: {
    arm64: '@embedded-postgres/linux-arm64',
    arm: '@embedded-postgres/linux-arm',
    ia32: '@embedded-postgres/linux-ia32',
    ppc64: '@embedded-postgres/linux-ppc64',
    x64: '@embedded-postgres/linux-x64',
  },
  win32: { x64: '@embedded-postgres/windows-x64' },
};

/** The `@embedded-postgres/*` package that holds the binaries for `platform` and `arch`. */
export function postgresPlatformPackage(platform: NodeJS.Platform, arch: string): string {
  const name = PLATFORM_PACKAGES[platform]?.[arch];
  if (name === undefined) throw new EmbeddedDatabaseError('unsupported_platform');
  return name;
}

export interface LocatePostgresDeps {
  /** `module.findPackageJSON`: the manifest `specifier` resolves to from `base`, if any. */
  readonly findPackageJSON: (specifier: string, base: string | URL) => string | undefined;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly realpath: (file: string) => string;
  /** The file's mode, or throws when it does not exist or is not a file. */
  readonly fileMode: (file: string) => number;
  readonly chmod: (file: string, mode: number) => void;
}

/** r-xr-xr-x: the bits `embedded-postgres` makes sure its binaries carry. */
const BINARY_PERMISSIONS = 0o555;

function regularFileMode(file: string): number {
  const stats = statSync(file);
  if (!stats.isFile()) throw new EmbeddedDatabaseError('binary_not_found');
  return stats.mode;
}

const defaultLocateDeps: LocatePostgresDeps = {
  findPackageJSON,
  platform: process.platform,
  arch: process.arch,
  realpath: realpathSync,
  fileMode: regularFileMode,
  chmod: chmodSync,
};

/**
 * The `postgres` server binary of the platform package `embedded-postgres` itself depends on,
 * resolved the way Node would resolve it from `embedded-postgres`'s real location. A missing step
 * is {@link EmbeddedDatabaseError} `binary_not_found`; an unknown platform is `unsupported_platform`.
 */
export function locatePostgresBinary(deps: LocatePostgresDeps = defaultLocateDeps): string {
  const platformPackage = postgresPlatformPackage(deps.platform, deps.arch);
  let binary: string;
  try {
    const library = deps.findPackageJSON('embedded-postgres', import.meta.url);
    if (library === undefined) throw new EmbeddedDatabaseError('binary_not_found');
    const binaries = deps.findPackageJSON(platformPackage, pathToFileURL(deps.realpath(library)));
    if (binaries === undefined) throw new EmbeddedDatabaseError('binary_not_found');
    binary = path.join(
      path.dirname(binaries),
      'native',
      'bin',
      deps.platform === 'win32' ? 'postgres.exe' : 'postgres',
    );
    const mode = deps.fileMode(binary);
    if (deps.platform !== 'win32' && (mode & BINARY_PERMISSIONS) !== BINARY_PERMISSIONS) {
      deps.chmod(binary, mode | BINARY_PERMISSIONS);
    }
  } catch (error) {
    if (error instanceof EmbeddedDatabaseError) throw error;
    throw new EmbeddedDatabaseError('binary_not_found', { cause: error });
  }
  return binary;
}

/** What the postmaster logs once it accepts connections (in the `C` message locale). */
const READY_LOG = 'database system is ready to accept connections';

/**
 * What a Windows postmaster prints, and then exits, when its account has administrator rights
 * (BH061-003, #892). `postgres.exe` checks this itself; `pg_ctl` starts it with a restricted token
 * that drops those rights, which {@link startPostmaster} falls back to.
 */
const ADMINISTRATOR_LOG = 'by a user with administrative permissions is not permitted';

/** How long a failed start waits for the postmaster's last output after it exited. */
const LAST_OUTPUT_MS = 500;

/** How long {@link Postmaster.stop} waits after SIGINT (or `taskkill`) before forcing the issue. */
const STOP_TIMEOUT_MS = 30_000;

/** How long a stop waits for the exit after SIGKILL to the process group. */
const KILL_GRACE_MS = 5_000;

/** The part of a spawned `ChildProcess` the postmaster's owner uses. */
interface PostmasterChild {
  readonly pid?: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
}

/** `process.once('exit')` and `process.off('exit')`, for the backstop. */
interface ExitEvents {
  once(event: 'exit', listener: () => void): unknown;
  off(event: 'exit', listener: () => void): unknown;
}

export interface PostmasterDeps {
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => PostmasterChild;
  readonly platform: NodeJS.Platform;
  /** `process.getuid`, which Windows lacks. */
  readonly getuid: (() => number) | undefined;
  /** The uid and gid of the `postgres` user, for a runtime running as root. */
  readonly postgresIds: () => Promise<{ readonly uid: number; readonly gid: number }>;
  /**
   * `process.kill`: with a negative pid on POSIX, to kill the postmaster's whole process group; on
   * Windows, to end a postmaster `pg_ctl` started, which is no child of this process.
   */
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Reads a text file: `postmaster.pid`, for the pid of a postmaster `pg_ctl` started. */
  readonly readFile: (file: string) => Promise<string>;
  readonly exitEvents: ExitEvents;
  readonly stopTimeoutMs?: number;
  readonly killGraceMs?: number;
}

function idOf(flag: '-u' | '-g'): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    execFile('id', [flag, 'postgres'], (error, stdout) => {
      if (error !== null) {
        reject(new Error('id could not name the postgres user', { cause: error }));
        return;
      }
      const id = Number.parseInt(stdout.trim(), 10);
      if (Number.isInteger(id)) resolve(id);
      else reject(new Error('id printed no number'));
    });
  });
}

async function postgresUserIds(): Promise<{ readonly uid: number; readonly gid: number }> {
  const [uid, gid] = await Promise.all([idOf('-u'), idOf('-g')]);
  return { uid, gid };
}

const defaultPostmasterDeps: PostmasterDeps = {
  spawn: (command, args, options) => spawn(command, args, options),
  platform: process.platform,
  getuid: process.getuid?.bind(process),
  postgresIds: postgresUserIds,
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  readFile: (file) => readFile(file, 'utf8'),
  exitEvents: process,
};

export interface StartPostmasterOptions {
  readonly binary: string;
  readonly dataDir: string;
  readonly port: number;
  /** Every chunk the postmaster writes, stdout and stderr alike. */
  readonly onLog: (message: string) => void;
}

/** A running postmaster. */
export interface Postmaster {
  readonly pid: number;
  /** Fast shutdown, bounded; resolves at once when the postmaster has already exited. Idempotent. */
  readonly stop: () => Promise<void>;
}

function chunkText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
  return String(chunk);
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

async function rootIds(
  deps: PostmasterDeps,
): Promise<{ readonly uid?: number; readonly gid?: number }> {
  if (deps.getuid?.() !== 0) return {};
  try {
    return await deps.postgresIds();
  } catch (error) {
    throw new EmbeddedDatabaseError('root_without_postgres_user', { cause: error });
  }
}

/** What the postmaster's output said, as {@link watchOutput} reads it. */
interface PostmasterOutput {
  /** Resolves once the ready line was seen. */
  readonly ready: Promise<void>;
  /** Resolves once every piped stream ended: every process holding them has exited. */
  readonly ended: Promise<void>;
  /** Whether the administrator refusal was seen so far. */
  readonly administrator: () => boolean;
}

/** Forward `child`'s stdout and stderr to `onLog` and watch them for the ready and refusal lines. */
function watchOutput(child: PostmasterChild, onLog: (message: string) => void): PostmasterOutput {
  let administrator = false;
  const ended: Promise<void>[] = [];
  const ready = new Promise<void>((resolve) => {
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null) continue;
      ended.push(
        new Promise<void>((done) => {
          stream.once('end', () => {
            done();
          });
        }),
      );
      let tail = '';
      stream.on('data', (chunk: unknown) => {
        const text = chunkText(chunk);
        onLog(text);
        // The ready line may arrive split across two chunks.
        const seen = tail + text;
        if (seen.includes(READY_LOG)) resolve();
        if (seen.includes(ADMINISTRATOR_LOG)) administrator = true;
        tail = seen.slice(-Math.max(READY_LOG.length, ADMINISTRATOR_LOG.length));
      });
    }
  });
  return {
    ready,
    ended: Promise.all(ended).then(() => undefined),
    administrator: () => administrator,
  };
}

/** Resolves `true` when `settled` settles within `timeoutMs`, `false` when the time runs out first. */
function settlesWithin(settled: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    void settled.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * The `exit` backstop's kill: this process is ending, so a failure has no caller left to reach and
 * is dropped.
 */
function endAtExit(kill: () => unknown): void {
  try {
    kill();
  } catch {
    // The process is ending; there is nothing left to report this to.
  }
}

/** The environment the postmaster runs with: the runtime's own, with `C` server messages. */
const postmasterEnv = (): NodeJS.ProcessEnv => ({ ...process.env, LC_MESSAGES: 'C' });

/**
 * Spawn the postmaster in its own process group and resolve once it accepts connections. Rejects
 * with {@link EmbeddedDatabaseError} `postmaster_exited` when it exits (or cannot be spawned) first,
 * which is what an uninitialised data directory or a taken port does; the caller reads the reason
 * off `onLog`.
 *
 * On Windows, a `postgres.exe` started from an account with administrator rights refuses to run
 * (#892; a GitHub-hosted Windows runner is one). The postmaster is then started again the way
 * PostgreSQL's own tooling does, through the bundled `pg_ctl.exe`, which drops those rights with a
 * restricted token ({@link startThroughPgCtl}). Only when that is refused the same way does the
 * start fail with `windows_administrator`.
 */
export async function startPostmaster(
  options: StartPostmasterOptions,
  deps: PostmasterDeps = defaultPostmasterDeps,
): Promise<Postmaster> {
  try {
    return await startDirectly(options, deps);
  } catch (error) {
    const refused =
      error instanceof EmbeddedDatabaseError && error.code === 'windows_administrator';
    if (!refused || deps.platform !== 'win32') throw error;
    return startThroughPgCtl(options, deps);
  }
}

/** The postmaster as a detached child of this process. */
async function startDirectly(
  options: StartPostmasterOptions,
  deps: PostmasterDeps,
): Promise<Postmaster> {
  const ids = await rootIds(deps);
  const child = deps.spawn(options.binary, ['-D', options.dataDir, '-p', String(options.port)], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: postmasterEnv(),
    ...ids,
  });

  let exited = false;
  /** Resolves with why the postmaster ended: its exit code and signal, or the spawn error. */
  const exit = new Promise<unknown>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
    child.once('error', (error) => {
      exited = true;
      resolve(error);
    });
  });

  const backstop = (): void => {
    if (!exited) endAtExit(() => child.kill('SIGINT'));
  };
  deps.exitEvents.once('exit', backstop);

  const output = watchOutput(child, options.onLog);
  const outcome = await Promise.race([
    output.ready.then(() => ({ ready: true }) as const),
    exit.then((ended) => ({ ready: false, ended }) as const),
  ]);
  const { pid } = child;
  if (!outcome.ready || pid === undefined) {
    deps.exitEvents.off('exit', backstop);
    // `exit` can come before the last output is read, and that output says why it exited.
    if (!outcome.ready) {
      await settlesWithin(output.ended, LAST_OUTPUT_MS);
      if (output.administrator()) {
        throw new EmbeddedDatabaseError('windows_administrator', { cause: outcome.ended });
      }
    }
    throw new EmbeddedDatabaseError('postmaster_exited', {
      cause: outcome.ready ? 'no pid' : outcome.ended,
    });
  }
  const stopTimeoutMs = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;

  const stopOnce = async (): Promise<void> => {
    deps.exitEvents.off('exit', backstop);
    if (exited) return;
    if (deps.platform === 'win32') {
      // Windows has no SIGINT for another process; `taskkill /t` ends the postmaster's tree.
      taskkill(deps, pid);
      if (!(await settlesWithin(exit, stopTimeoutMs))) {
        throw new EmbeddedDatabaseError('stop_timeout');
      }
      return;
    }
    child.kill('SIGINT');
    if (await settlesWithin(exit, stopTimeoutMs)) return;
    try {
      deps.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (isNoSuchProcess(error)) return;
      throw new EmbeddedDatabaseError('stop_timeout', { cause: error });
    }
    if (!(await settlesWithin(exit, killGraceMs))) throw new EmbeddedDatabaseError('stop_timeout');
  };

  let stopping: Promise<void> | undefined;
  return {
    pid,
    stop: () => {
      stopping ??= stopOnce();
      return stopping;
    },
  };
}

/** End `pid` and every process it started, forcibly; the caller watches for the exit. */
function taskkill(deps: PostmasterDeps, pid: number): void {
  const child = deps.spawn('taskkill', ['/pid', String(pid), '/f', '/t'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once('error', () => undefined);
}

/** The pid on the first line of a `postmaster.pid`, if it holds one. */
function lockFilePid(text: string): number | undefined {
  const pid = Number.parseInt(text.split('\n', 1)[0]?.trim() ?? '', 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Windows, from an account with administrator rights (#892): `pg_ctl start -W` creates a
 * restricted token without the Administrators group and its privileges, starts
 * `cmd /c postgres.exe ...` with it, and exits at once. The postmaster inherits `pg_ctl`'s piped
 * stdout and stderr (`cmd` sends the postmaster's stderr to stdout), so its log still reaches
 * `onLog`, and the pipes end only once the postmaster, its backends and `cmd` have all exited. That
 * end is how this start and {@link Postmaster.stop} see it exit, since it is no child of this
 * process.
 *
 * `pg_ctl` is spawned without `detached`: Node then gives it a hidden console of its own
 * (`CREATE_NO_WINDOW`), which the postmaster shares, so a terminal's Ctrl+C still reaches only the
 * launcher. A detached `pg_ctl` would have no console at all, and the `cmd` it starts would open a
 * visible one.
 *
 * The pid is read from `postmaster.pid`, which the postmaster writes before it is ready. A stop
 * asks `pg_ctl stop -m fast`, the fast shutdown SIGINT is on POSIX, and ends the tree with
 * `taskkill` when that does not finish in time.
 */
async function startThroughPgCtl(
  options: StartPostmasterOptions,
  deps: PostmasterDeps,
): Promise<Postmaster> {
  const pgCtl = path.join(path.dirname(options.binary), 'pg_ctl.exe');
  const port = `-p ${String(options.port)}`;
  const starter = deps.spawn(pgCtl, ['start', '-D', options.dataDir, '-o', port, '-W'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: postmasterEnv(),
  });
  const output = watchOutput(starter, options.onLog);
  let exited = false;
  /** Resolves once the postmaster is gone: its output ended, or `pg_ctl` could not be spawned. */
  const gone = new Promise<unknown>((resolve) => {
    void output.ended.then(() => {
      resolve('output ended');
    });
    starter.once('error', resolve);
  }).then((reason) => {
    exited = true;
    return reason;
  });

  const outcome = await Promise.race([
    output.ready.then(() => ({ ready: true }) as const),
    gone.then((ended) => ({ ready: false, ended }) as const),
  ]);
  if (!outcome.ready) {
    // `pg_ctl` itself could not be spawned, or its postmaster was refused all the same: the
    // administrator rights are still the reason. Any other exit is the postmaster's own, which on
    // an empty data directory is what makes the caller run initdb.
    if (outcome.ended instanceof Error || output.administrator()) {
      throw new EmbeddedDatabaseError('windows_administrator', { cause: outcome.ended });
    }
    throw new EmbeddedDatabaseError('postmaster_exited', { cause: outcome.ended });
  }

  let pid: number | undefined;
  try {
    pid = lockFilePid(await deps.readFile(path.join(options.dataDir, 'postmaster.pid')));
  } catch {
    pid = undefined;
  }

  const backstop = (): void => {
    if (exited || pid === undefined) return;
    const known = pid;
    endAtExit(() => {
      deps.kill(known, 'SIGINT');
    });
  };
  deps.exitEvents.once('exit', backstop);

  const stopTimeoutMs = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;
  const stopOnce = async (): Promise<void> => {
    deps.exitEvents.off('exit', backstop);
    if (exited) return;
    deps
      .spawn(pgCtl, ['stop', '-D', options.dataDir, '-m', 'fast', '-W'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      .once('error', () => undefined);
    if (await settlesWithin(gone, stopTimeoutMs)) return;
    if (pid !== undefined) taskkill(deps, pid);
    if (!(await settlesWithin(gone, killGraceMs))) throw new EmbeddedDatabaseError('stop_timeout');
  };
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= stopOnce();
    return stopping;
  };

  if (pid === undefined) {
    // A postmaster without a known pid cannot be ended by force later: stop it now, and fail.
    let stopFailure: unknown;
    try {
      await stop();
    } catch (error) {
      stopFailure = error;
    }
    throw new EmbeddedDatabaseError('postmaster_exited', {
      cause: stopFailure === undefined ? 'no pid' : new AggregateError([stopFailure], 'no pid'),
    });
  }
  return { pid, stop };
}
