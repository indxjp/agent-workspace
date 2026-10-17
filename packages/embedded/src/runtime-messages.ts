/**
 * S1-11 (#449): the runtime's side of the local-runtime IPC protocol (S1-01, ADR-0109).
 *
 * The runtime accepts one `start` from `aw dev` and answers with `ready`, `credential` or
 * `failed`. Every message is parsed with its direction's schema, on the way in and on the way out,
 * so the runtime can neither act on a message travelling the wrong way nor send one `aw` would
 * refuse. {@link failureMessage} is the one place a thrown error becomes text the person sees.
 */
import { DeploymentPostureError } from '@agent-workspace/core/posture';
import { LocalCredentialError } from '@agent-workspace/web/server/cli-auth/local-credential';
import { StartWebOptionsError } from '@agent-workspace/web/server/start';
import {
  type LocalRuntimeChildMessage,
  LocalRuntimeChildMessageSchema,
  LocalRuntimeParentMessageSchema,
  type LocalRuntimeStartMessage,
} from '@indx-workspace/contracts/local-runtime';

import { DockerSandboxError } from './docker-sandbox.js';
import { EmbeddedDatabasePortError, EmbeddedDatabasePortInUseError } from './embedded-db.js';
import { LocalRuntimeEnvironmentError, LocalRuntimePortsBusyError } from './local-environment.js';
import { LocalSecretsError } from './local-secrets.js';
import { EmbeddedDatabaseError } from './postmaster.js';

/** How long the runtime waits for `start` before giving up. */
const DEFAULT_START_TIMEOUT_MS = 60_000;

/** The longest failure message the protocol carries. */
const FAILURE_MESSAGE_MAX_LENGTH = 4096;

/** The IPC channel to `aw dev`, injectable for tests. */
export interface LocalRuntimeChannel {
  /** Send `message`; resolves once it has been handed to the channel, so it is flushed before exit. */
  send(message: unknown): Promise<void>;
  /** Subscribe to incoming messages; returns the unsubscribe function. */
  onMessage(listener: (message: unknown) => void): () => void;
  /** Subscribe to the channel closing; returns the unsubscribe function. */
  onDisconnect(listener: () => void): () => void;
}

class LocalRuntimeChannelError extends Error {
  constructor() {
    super('this process has no IPC channel; aw dev starts the local runtime');
    this.name = 'LocalRuntimeChannelError';
  }
}

/** The channel over this process's IPC (`process.send`, `message`, `disconnect`). */
export function processChannel(): LocalRuntimeChannel {
  return {
    send: (message) =>
      new Promise<void>((resolve, reject) => {
        if (process.send === undefined) {
          reject(new LocalRuntimeChannelError());
          return;
        }
        process.send(message, (error: Error | null) => {
          if (error === null) resolve();
          else reject(error);
        });
      }),
    onMessage: (listener) => {
      process.on('message', listener);
      return () => void process.off('message', listener);
    },
    onDisconnect: (listener) => {
      process.on('disconnect', listener);
      return () => void process.off('disconnect', listener);
    },
  };
}

export type LocalRuntimeProtocolErrorCode =
  'invalid_start' | 'start_timeout' | 'disconnected' | 'stopped' | 'invalid_outgoing';

const PROTOCOL_MESSAGES: Readonly<Record<LocalRuntimeProtocolErrorCode, string>> = {
  invalid_start: 'the local runtime received an invalid start message',
  start_timeout: 'the local runtime received no start message in time',
  disconnected: 'the IPC channel closed before the local runtime started',
  stopped: 'the local runtime was stopped before it started',
  invalid_outgoing: 'the local runtime produced a message its protocol does not allow',
};

export class LocalRuntimeProtocolError extends Error {
  readonly code: LocalRuntimeProtocolErrorCode;

  constructor(code: LocalRuntimeProtocolErrorCode) {
    super(PROTOCOL_MESSAGES[code]);
    this.name = 'LocalRuntimeProtocolError';
    this.code = code;
  }
}

export type LocalLauncherErrorCode =
  | 'invalid_project_dir'
  | 'dotenv_unreadable'
  | 'contracts_skew'
  | 'workspace_mismatch'
  | 'runtime_profile_not_prepared'
  | 'docker_profile_not_default'
  | 'startup_timeout'
  | 'already_running';

/** What a launcher message may name: a file path, a process id and a port, never a value. */
interface LauncherMessageContext {
  readonly file: string;
  readonly pid: number | undefined;
  readonly port: number | undefined;
}

/**
 * Issue #560: `.agent-workspace/runtime.pid` cannot prove that the process it records is an aw
 * runtime (a stale record's pid can be reused by an unrelated process), so the message says only
 * what the file records and makes stopping a runtime conditional; it never tells the user to stop
 * that pid.
 */
function alreadyRunningMessage({ pid, port }: LauncherMessageContext): string {
  const collision =
    port === undefined ? 'a port is already in use' : `port ${String(port)} is already in use`;
  const recorded =
    pid === undefined ? '' : ` (.agent-workspace/runtime.pid records process ${String(pid)})`;
  return `${collision}, and this project's local runtime may already be running${recorded}; if aw dev is running in this project, stop that aw dev before running it again`;
}

const LAUNCHER_MESSAGES: Readonly<
  Record<LocalLauncherErrorCode, (context: LauncherMessageContext) => string>
> = {
  invalid_project_dir: () => 'the project directory must be an existing absolute directory',
  dotenv_unreadable: ({ file }) => `${file} could not be read; it must be a readable .env file`,
  contracts_skew: () => 'the local runtime does not serve the contracts version it was built with',
  workspace_mismatch: () =>
    'BOOTSTRAP_ADMIN is not a member of the workspace the local runtime seeded; check WORKSPACE_SLUG',
  runtime_profile_not_prepared: () =>
    'the local runtime could not prepare the workspace default runtime profile named local',
  docker_profile_not_default: () =>
    'the docker sandbox needs a runtime profile on the docker driver as the workspace default, and the local runtime could not make one: a default chosen in the workspace, a profile named docker on another driver, or one with a restricted network or allowed domains is in the way; nothing was run',
  startup_timeout: () => 'the local runtime did not become ready in time',
  already_running: alreadyRunningMessage,
};

export interface LocalLauncherErrorOptions {
  readonly cause?: unknown;
  /** The file the error is about, for `dotenv_unreadable`; a path is safe to show. */
  readonly file?: string;
  /** The process the pid file records, for `already_running`; a pid is safe to show. */
  readonly pid?: number;
  /** The port that collided, for `already_running`. */
  readonly port?: number;
}

/** A launcher step refused; the message names no value, only a file path, a pid or a port. */
export class LocalLauncherError extends Error {
  readonly code: LocalLauncherErrorCode;

  constructor(code: LocalLauncherErrorCode, options: LocalLauncherErrorOptions = {}) {
    super(
      LAUNCHER_MESSAGES[code]({
        file: options.file ?? '.env',
        pid: options.pid,
        port: options.port,
      }),
      'cause' in options ? { cause: options.cause } : undefined,
    );
    this.name = 'LocalLauncherError';
    this.code = code;
  }
}

export interface ReceiveStartOptions {
  readonly timeoutMs?: number | undefined;
  /** Aborting it (a signal arrived) rejects the wait with `stopped` at once. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Wait for the first message on `channel` and parse it as `start`. Rejects with
 * {@link LocalRuntimeProtocolError} when it is anything else, when none arrives in time, when
 * the channel closes first, or when `options.signal` is aborted.
 */
export function receiveStartMessage(
  channel: LocalRuntimeChannel,
  options: ReceiveStartOptions = {},
): Promise<LocalRuntimeStartMessage> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  return new Promise<LocalRuntimeStartMessage>((resolve, reject) => {
    const cleanups: (() => void)[] = [];
    const settle = (outcome: () => void) => {
      for (const cleanup of cleanups) cleanup();
      outcome();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new LocalRuntimeProtocolError('start_timeout')));
    }, timeoutMs);
    cleanups.push(() => clearTimeout(timer));
    cleanups.push(
      channel.onMessage((message) => {
        const parsed = LocalRuntimeParentMessageSchema.safeParse(message);
        if (parsed.success) settle(() => resolve(parsed.data));
        else settle(() => reject(new LocalRuntimeProtocolError('invalid_start')));
      }),
    );
    cleanups.push(
      channel.onDisconnect(() => {
        settle(() => reject(new LocalRuntimeProtocolError('disconnected')));
      }),
    );
    const { signal } = options;
    if (signal !== undefined) {
      const onAbort = () => {
        settle(() => reject(new LocalRuntimeProtocolError('stopped')));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      cleanups.push(() => {
        signal.removeEventListener('abort', onAbort);
      });
    }
  });
}

/** Parse `message` as a child → parent message, then send it. */
export async function sendChildMessage(
  channel: LocalRuntimeChannel,
  message: LocalRuntimeChildMessage,
): Promise<void> {
  const parsed = LocalRuntimeChildMessageSchema.safeParse(message);
  if (!parsed.success) throw new LocalRuntimeProtocolError('invalid_outgoing');
  await channel.send(parsed.data);
}

/** Every C0 and C1 control character but a tab and a line feed. */
const UNSAFE_CONTROL_CHARACTERS = /[^\P{Cc}\t\n]/gu;

function terminalSafe(text: string): string {
  const cleaned = text.replace(UNSAFE_CONTROL_CHARACTERS, '').slice(0, FAILURE_MESSAGE_MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : 'the local runtime failed to start';
}

function addressInUsePort(error: unknown): number | undefined {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') {
    return undefined;
  }
  if (!('port' in error)) return undefined;
  const { port } = error;
  return typeof port === 'number' && Number.isInteger(port) ? port : undefined;
}

/** An `EACCES` listen error's port: the process may not bind it (a port below 1024, as non-root). */
function listenPermissionPort(error: unknown): number | undefined {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'EACCES') return undefined;
  if (!('port' in error)) return undefined;
  const { port } = error;
  return typeof port === 'number' && Number.isInteger(port) ? port : undefined;
}

/** The lowest port an unprivileged process can listen on. */
const FIRST_UNPRIVILEGED_PORT = 1024;

function permissionDeniedMessage(port: number): string {
  const line = `permission denied to listen on port ${String(port)}`;
  return port < FIRST_UNPRIVILEGED_PORT
    ? `${line}; ports below 1024 need elevated privileges, choose a port from 1024 to 65535`
    : line;
}

/**
 * The port of a listener collision (`EADDRINUSE` with a port) in `error`, on its own or inside an
 * AggregateError; `undefined` for any other failure. The launcher uses it to tell a second
 * `aw dev` in the same project apart.
 */
export function collisionPort(error: unknown): number | undefined {
  const own = addressInUsePort(error);
  if (own !== undefined || !(error instanceof AggregateError)) return own;
  const inner: unknown[] = error.errors;
  for (const candidate of inner) {
    const port = addressInUsePort(candidate);
    if (port !== undefined) return port;
  }
  return undefined;
}

/** The errors whose own message was written to be shown: it names no secret and no value. */
function isTypedError(error: unknown): error is Error {
  return (
    error instanceof LocalSecretsError ||
    error instanceof LocalRuntimeEnvironmentError ||
    error instanceof LocalRuntimeProtocolError ||
    error instanceof LocalRuntimeChannelError ||
    error instanceof LocalLauncherError ||
    error instanceof DeploymentPostureError ||
    error instanceof LocalCredentialError ||
    error instanceof StartWebOptionsError ||
    error instanceof EmbeddedDatabaseError ||
    error instanceof EmbeddedDatabasePortError ||
    error instanceof DockerSandboxError
  );
}

function className(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name;
  return typeof error;
}

/**
 * The `failed.message` for `error`: the typed errors' own messages, the embedded PostgreSQL's own
 * in-use message (which says what to do, #556), the launcher's every-busy-port message (#660),
 * `port <n> is already in use` for any other listener collision, `permission denied to listen on port <n>` for an `EACCES` listen error (with a hint
 * about privileged ports below 1024), and otherwise a generic line naming only the error's class.
 * Both port errors are found on their own or inside an AggregateError. It never
 * carries an untyped error's message (which could quote a token or a connection string), and it is
 * terminal-safe and at most 4096 characters.
 */
export function failureMessage(error: unknown): string {
  if (
    error instanceof EmbeddedDatabasePortInUseError ||
    error instanceof LocalRuntimePortsBusyError
  ) {
    return terminalSafe(error.message);
  }
  const port = addressInUsePort(error);
  if (port !== undefined) return `port ${String(port)} is already in use`;
  const deniedPort = listenPermissionPort(error);
  if (deniedPort !== undefined) return permissionDeniedMessage(deniedPort);
  if (isTypedError(error)) return terminalSafe(error.message);
  if (error instanceof AggregateError) {
    const inner: unknown[] = error.errors;
    const known = inner.find(
      (candidate) =>
        candidate instanceof EmbeddedDatabasePortInUseError ||
        isTypedError(candidate) ||
        addressInUsePort(candidate) !== undefined ||
        listenPermissionPort(candidate) !== undefined,
    );
    if (known !== undefined) return failureMessage(known);
  }
  return terminalSafe(`the local runtime failed to start (${className(error)})`);
}
