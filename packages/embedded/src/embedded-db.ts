import { mkdir, readFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

import { z } from 'zod';

// `.ts` rather than `.js`: a test imports this file under Node's own type stripping, which does not
// map one to the other (`rewriteRelativeImportExtensions` does, for the contributor build).
import {
  EMBEDDED_POSTGRES_MAJOR,
  EmbeddedDatabaseError,
  locatePostgresBinary,
  type Postmaster,
  type StartPostmasterOptions,
  startPostmaster,
} from './postmaster.ts';

export interface EmbeddedDatabase {
  readonly url: string;
  readonly close: () => Promise<void>;
}

/**
 * The port the local PostgreSQL listens on unless `AW_DATABASE_PORT` or a caller names another.
 *
 * It lies outside every operating system's ephemeral/dynamic port range (Linux 32768-60999,
 * Windows and macOS 49152-65535): under WSL2 mirrored networking Linux cannot bind a port in
 * Windows' dynamic range, so the former 54329 was refused although nothing listened on it (#556).
 * It stays fixed rather than falling back to another port, so a second start on the same data
 * directory fails by naming the port instead of starting a second postmaster (ADR-0109).
 */
export const EMBEDDED_DATABASE_PORT = 25432;

/** The variable (process environment or the project's `.env`) that overrides the port. */
export const AW_DATABASE_PORT_VARIABLE = 'AW_DATABASE_PORT';

/** How long {@link probeLoopbackListener} waits for a connection before answering `unknown`. */
const LISTENER_PROBE_TIMEOUT_MS = 500;

/** What the postmaster logs when it cannot listen on its port. */
const SOCKET_FAILURE_LOG = /could not create any TCP\/IP sockets|Address already in use/iu;

/** A port `aw dev` may use: one to five digits, then an unprivileged port number. */
const DatabasePortSchema = z
  .string()
  .regex(/^[0-9]{1,5}$/u)
  .transform((value) => Number(value))
  .pipe(z.number().int().min(1024).max(65_535));

/**
 * The embedded PostgreSQL's port is taken: a process accepts connections on it, typically another
 * project's local runtime or a PostgreSQL a killed run left behind. It carries `code: 'EADDRINUSE'` and the numeric `port`, as
 * Node's own listener errors do; its message starts `port <n> is already in use` and says what to do.
 */
export class EmbeddedDatabasePortInUseError extends Error {
  readonly code = 'EADDRINUSE';
  readonly port: number;

  constructor(port: number, options?: { readonly cause: unknown }) {
    super(
      `port ${String(port)} is already in use: another process holds it (for example another ` +
        "project's aw dev, or a PostgreSQL a killed run left behind); stop it, or set " +
        'AW_DATABASE_PORT in .env to another free port below 49152',
      options,
    );
    this.name = 'EmbeddedDatabasePortInUseError';
    this.port = port;
  }
}

export type EmbeddedDatabasePortErrorCode =
  'invalid_port' | 'port_conflict' | 'port_reserved' | 'port_unavailable';

/** The variables naming the local runtime's other listeners, with the port each defaults to. */
const SERVICE_PORT_VARIABLES = [
  ['PORT', 3000],
  ['GATEWAY_PORT', 4000],
  ['RUNNER_PORT', 8080],
] as const;

export type ServicePortVariable = (typeof SERVICE_PORT_VARIABLES)[number][0];

export interface EmbeddedDatabasePortErrorOptions {
  readonly cause?: unknown;
  /** For `port_conflict`: the service variable whose port the database port equals. */
  readonly conflictsWith?: ServicePortVariable;
}

const PORT_REMEDY =
  'set AW_DATABASE_PORT in .env to a free port below 49152, or DATABASE_URL to your own PostgreSQL';

function portErrorMessage(
  code: EmbeddedDatabasePortErrorCode,
  port: number | undefined,
  conflictsWith: ServicePortVariable | undefined,
): string {
  const portText = String(port);
  switch (code) {
    case 'invalid_port':
      return `${AW_DATABASE_PORT_VARIABLE} must be a whole number from 1024 to 65535`;
    case 'port_conflict': {
      const other = conflictsWith ?? 'another service port';
      return (
        `port ${portText} is both the embedded PostgreSQL's port and ${other}: set ` +
        `AW_DATABASE_PORT (or ${other}) in .env so the two differ`
      );
    }
    case 'port_reserved':
      return (
        `port ${portText} cannot be bound on 127.0.0.1, but no process is listening on it: ` +
        "the operating system reserves it (under WSL2 mirrored networking, Windows' dynamic " +
        `ports 49152-65535 cannot be bound); ${PORT_REMEDY}`
      );
    case 'port_unavailable':
      return (
        `port ${portText} cannot be bound on 127.0.0.1, and whether a process holds it could not ` +
        'be determined: another process holds it or the operating system reserves it; stop ' +
        `whatever holds it, or ${PORT_REMEDY}`
      );
  }
}

/**
 * The embedded PostgreSQL's port cannot be used for a reason other than a listener known to hold
 * it: `AW_DATABASE_PORT` is not a valid port (`invalid_port`), the database port equals the web,
 * gateway or runner port (`port_conflict`), the operating system refuses the bind although nothing
 * listens (`port_reserved`, #556), or the bind is refused and the listener check is inconclusive
 * (`port_unavailable`). The message names no value but the port and a variable name.
 */
export class EmbeddedDatabasePortError extends Error {
  readonly code: EmbeddedDatabasePortErrorCode;
  readonly port: number | undefined;

  constructor(
    code: EmbeddedDatabasePortErrorCode,
    port?: number,
    options: EmbeddedDatabasePortErrorOptions = {},
  ) {
    super(
      portErrorMessage(code, port, options.conflictsWith),
      'cause' in options ? { cause: options.cause } : undefined,
    );
    this.name = 'EmbeddedDatabasePortError';
    this.code = code;
    this.port = port;
  }
}

/** The port `variable` names in `env`, its default when unset or blank, undefined when invalid. */
function servicePort(
  env: Readonly<Record<string, string | undefined>>,
  variable: ServicePortVariable,
  fallback: number,
): number | undefined {
  const raw = env[variable]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  return /^[0-9]{1,5}$/u.test(raw) ? Number(raw) : undefined;
}

/**
 * The port the embedded PostgreSQL uses: `AW_DATABASE_PORT` from `env` when it is set and not
 * blank, otherwise {@link EMBEDDED_DATABASE_PORT}. An invalid value is refused with
 * {@link EmbeddedDatabasePortError} `invalid_port`, whose message does not repeat it. A port equal
 * to the web (`PORT`, 3000 by default), gateway (`GATEWAY_PORT`, 4000) or runner (`RUNNER_PORT`,
 * 8080) port is refused with `port_conflict`, naming the clash, before anything starts: otherwise
 * the database would take it and that service would later fail with a bare "already in use".
 */
export function resolveEmbeddedDatabasePort(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env[AW_DATABASE_PORT_VARIABLE];
  let port = EMBEDDED_DATABASE_PORT;
  if (raw !== undefined && raw.trim().length > 0) {
    const parsed = DatabasePortSchema.safeParse(raw);
    if (!parsed.success) throw new EmbeddedDatabasePortError('invalid_port');
    port = parsed.data;
  }
  for (const [variable, fallback] of SERVICE_PORT_VARIABLES) {
    if (servicePort(env, variable, fallback) === port) {
      throw new EmbeddedDatabasePortError('port_conflict', port, { conflictsWith: variable });
    }
  }
  return port;
}

export interface EmbeddedDatabaseOptions {
  /**
   * Resolves when `port` can be listened on; rejects with the bind error (`EADDRINUSE`, `EACCES`)
   * when it cannot. {@link probeLoopbackPort} by default.
   */
  readonly probePort?: (port: number) => Promise<void>;
  /**
   * Whether a process listens on `127.0.0.1:port`, asked only when the bind failed, to tell a
   * port in use from one the operating system reserves. {@link probeLoopbackListener} by default.
   */
  readonly probeListener?: (port: number) => Promise<LoopbackListenerState>;
  /** The `postgres` server binary; {@link locatePostgresBinary} by default. */
  readonly locatePostgres?: () => string;
  /** Spawn the postmaster and resolve once it is ready; {@link startPostmaster} by default. */
  readonly startPostmaster?: (options: StartPostmasterOptions) => Promise<Postmaster>;
}

/** Listen on `127.0.0.1:port` and close again, to learn whether the port is free. */
export function probeLoopbackPort(port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => {
        resolve();
      });
    });
  });
}

/** `listening`: a connection was accepted; `none`: refused; `unknown`: anything else. */
export type LoopbackListenerState = 'listening' | 'none' | 'unknown';

/** Connect to `127.0.0.1:port`, to learn whether a process listens on it. */
export function probeLoopbackListener(port: number): Promise<LoopbackListenerState> {
  return new Promise<LoopbackListenerState>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const settle = (state: LoopbackListenerState) => {
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(LISTENER_PROBE_TIMEOUT_MS, () => {
      settle('unknown');
    });
    socket.once('connect', () => {
      settle('listening');
    });
    socket.once('error', (error: Error) => {
      settle(errorCode(error) === 'ECONNREFUSED' ? 'none' : 'unknown');
    });
  });
}

/** `free`: `127.0.0.1:port` can be bound; otherwise why the bind was refused, as the listener check found. */
export type LoopbackPortState = 'free' | LoopbackListenerState;

/**
 * Whether `127.0.0.1:port` can be bound and, when it cannot, whether a process listens on it
 * (`listening`), the operating system reserves it (`none`, #556), or that could not be told
 * (`unknown`). A bind failure other than `EADDRINUSE` / `EACCES` is rethrown.
 */
export async function loopbackPortState(port: number): Promise<LoopbackPortState> {
  try {
    await probeLoopbackPort(port);
    return 'free';
  } catch (error) {
    if (!isBindRefused(error)) throw error;
    const listener = await probeLoopbackListener(port);
    return listener === 'none' && (await freeOnRecheck(port, probeLoopbackPort))
      ? 'free'
      : listener;
  }
}

/** How long a bind refused with nothing listening is given before it counts as reserved. */
const RESERVED_RECHECK_MS = 500;

/**
 * Whether a port whose bind was refused while nothing listens on it binds a moment later. A port a
 * process has just closed can refuse a bind briefly, which read as "reserved by the operating
 * system" right after a run (BH061-063); a port the system really reserves still refuses.
 */
async function freeOnRecheck(
  port: number,
  probePort: (port: number) => Promise<void>,
): Promise<boolean> {
  await delay(RESERVED_RECHECK_MS);
  try {
    await probePort(port);
    return true;
  } catch (error) {
    if (!isBindRefused(error)) throw error;
    return false;
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

function isBindRefused(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'EADDRINUSE' || code === 'EACCES';
}

/** A file's text, or undefined when it does not exist. */
async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/** Whether the process a `postmaster.pid` file names (its first line) is still running. */
function isLiveProcess(pidFile: string | undefined): boolean {
  const pid = Number(pidFile?.split('\n', 1)[0]?.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to another user, which still holds the directory.
    return errorCode(error) === 'EPERM';
  }
}

const DATABASE_USER = 'agent_workspace';
const DATABASE_PASSWORD = 'agent_workspace_local';

/**
 * `initdb` through `embedded-postgres`, imported here rather than at the top of the file because
 * importing it installs a process-wide exit hook: it depends on `async-exit-hook`, which registers a
 * `beforeExit` listener that calls `process.exit(0)` on the next tick. Any module that reached
 * this file would lose the ability to leave a non-zero `process.exitCode` behind — and `index.ts`
 * re-exports `startWorkspace`, so every `agent-workspace` invocation reached it, including
 * `validate`, whose refusals must exit 1. Only a first start, on an empty data directory, imports
 * it now. Its `start()` is never called (see `postmaster.ts`), so its exit hook has no running
 * instance to stop.
 */
async function initialiseWithLibrary(
  root: string,
  port: number,
  onLog: (message: string) => void,
): Promise<void> {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const library = new EmbeddedPostgres({
    databaseDir: root,
    port,
    user: DATABASE_USER,
    password: DATABASE_PASSWORD,
    persistent: true,
    onLog,
  });
  await library.initialise();
}

/**
 * Start the Compose-less local PostgreSQL.
 *
 * The postmaster is spawned by {@link startPostmaster}, in its own process group, so a terminal's
 * Ctrl+C reaches only the launcher, which stops it last (S1-25, #510, ADR-0112). A first start on an
 * empty data directory fails, and is followed by `initdb` and a second start.
 *
 * A port already in use is refused with {@link EmbeddedDatabasePortInUseError}: by probing it
 * first, and, should the postmaster still fail to bind it, from the postmaster's own log. When the
 * probe cannot bind the port (`EADDRINUSE` or `EACCES`) but nothing accepts a connection on it, the
 * operating system reserves it, as Windows' dynamic range is under WSL2 mirrored networking (#556),
 * and the start is refused with {@link EmbeddedDatabasePortError} `port_reserved`. When the listener
 * check is inconclusive (it timed out, or failed other than by a refused connection), the start is
 * refused with `port_unavailable`, which names both causes and both remedies. A failed start
 * leaves nothing running: {@link startPostmaster} rejects only once the postmaster has exited.
 */
export async function startEmbeddedDatabase(
  root = path.resolve('.agent-workspace', 'postgres'),
  port = EMBEDDED_DATABASE_PORT,
  options: EmbeddedDatabaseOptions = {},
): Promise<EmbeddedDatabase> {
  const probePort = options.probePort ?? probeLoopbackPort;
  try {
    await probePort(port);
  } catch (error) {
    if (!isBindRefused(error)) throw error;
    const listener = await (options.probeListener ?? probeLoopbackListener)(port);
    if (listener === 'none') {
      if (!(await freeOnRecheck(port, probePort))) {
        throw new EmbeddedDatabasePortError('port_reserved', port, { cause: error });
      }
    } else if (listener === 'unknown') {
      throw new EmbeddedDatabasePortError('port_unavailable', port, { cause: error });
    } else {
      throw new EmbeddedDatabasePortInUseError(port, { cause: error });
    }
  }
  const binary = (options.locatePostgres ?? locatePostgresBinary)();
  const spawnPostmaster = options.startPostmaster ?? ((start) => startPostmaster(start));
  await mkdir(root, { recursive: true });
  let socketFailure = false;
  const onLog = (message: string) => {
    if (SOCKET_FAILURE_LOG.test(message)) socketFailure = true;
    console.log(message);
  };
  const start = () => spawnPostmaster({ binary, dataDir: root, port, onLog });
  const failStart = (error: unknown): never => {
    if (socketFailure) throw new EmbeddedDatabasePortInUseError(port, { cause: error });
    throw error;
  };
  let postmaster: Postmaster;
  try {
    postmaster = await start();
  } catch (error) {
    if (socketFailure) return failStart(error);
    // Only a postmaster that exited can mean an uninitialised data directory. A typed failure to
    // start it at all (no postgres user for root, no binary) is the reason, and initdb would only
    // replace it with the library's own untyped error.
    if (error instanceof EmbeddedDatabaseError && error.code !== 'postmaster_exited') throw error;
    // initdb writes PG_VERSION. An initialised cluster that will not start is never handed to
    // initdb: it refuses a non-empty directory with advice to empty it, which deletes every local
    // row (BH061-006). The usual cause is a postmaster a killed run left behind; the other one this
    // names is a directory an earlier release initialised with another PostgreSQL major.
    const version = await readOptional(path.join(root, 'PG_VERSION'));
    if (version !== undefined) {
      if (isLiveProcess(await readOptional(path.join(root, 'postmaster.pid')))) {
        throw new EmbeddedDatabaseError('data_directory_in_use', { cause: error });
      }
      if (version.trim() !== EMBEDDED_POSTGRES_MAJOR) {
        throw new EmbeddedDatabaseError('data_directory_version', { cause: error });
      }
      return failStart(error);
    }
    try {
      await initialiseWithLibrary(root, port, onLog);
      postmaster = await start();
    } catch (retryError) {
      return failStart(retryError);
    }
  }
  return {
    url: `postgresql://${DATABASE_USER}:${DATABASE_PASSWORD}@127.0.0.1:${String(port)}/postgres`,
    close: () => postmaster.stop(),
  };
}
