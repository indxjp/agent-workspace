import { fork, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { CONTRACTS_VERSION } from '@indx-workspace/contracts';
import {
  LocalRuntimeChildMessageSchema,
  type LocalRuntimeChildMessage,
  type LocalRuntimeStartMessage,
} from '@indx-workspace/contracts/local-runtime';
import type { z } from 'zod';

import { CommandRefusedError, type CliIo } from '../io.js';
import { AW_VERSION } from '../version.js';
import { withoutNames } from './environment.js';
import { saveLocalApiKey } from './local-credentials.js';
import { localProjectUrl } from './project.js';
import { EMBEDDED_INSTALL_FIX, EMBEDDED_PACKAGE } from './resolve.js';

/**
 * How long the local runtime has to stop after it is asked to before it is killed. Long enough for
 * the runtime to stop its embedded PostgreSQL cleanly; short enough that a hung runtime never keeps
 * the terminal (ADR-0109).
 */
const LOCAL_RUNTIME_STOP_GRACE_MS = 10_000;

/** The local runtime announced it is serving. */
interface LocalRuntimeReady {
  /** The URL the runtime announced; its origin is `localProjectUrl(port)`. */
  readonly url: string;
}

/** `aw` holds the local runtime's API key for its local workspace (ADR-0109, S1-21). */
export interface LocalRuntimeSession {
  /** The control plane URL the credential is stored under: `localProjectUrl(port)`. */
  readonly baseUrl: string;
  /**
   * The local workspace's API key the runtime issued (ADR-0109, S1-21). Never printed, logged or
   * written anywhere but the credentials file; the runtime revokes it when it stops.
   */
  readonly apiKey: string;
  readonly workspaceSlug: string;
}

/**
 * What `aw dev` does at each step of the runtime's life. Each hook runs in order, after the step's
 * own work (printing nothing itself); a hook that throws stops the runtime with its error. A later
 * unit (S1-15) adds its work after sign-in here.
 */
interface LocalRuntimeHooks {
  readonly onReady?: (ready: LocalRuntimeReady) => Promise<void> | void;
  readonly onSignedIn?: (session: LocalRuntimeSession) => Promise<void> | void;
}

export interface SuperviseOptions {
  /** The runtime's `./launch` export, as `resolveLocalRuntime` found it. */
  readonly launchPath: string;
  readonly cwd: string;
  readonly io: CliIo;
  /** Aborted on SIGINT or SIGTERM: the runtime is asked to stop, then killed after the grace. */
  readonly signal: AbortSignal;
  readonly start: LocalRuntimeStartMessage;
  readonly hooks: LocalRuntimeHooks;
  /**
   * Where the runtime's stdout and stderr go (issue #692): `.aw/logs/runtime.log`, replaced on
   * every start. When the runtime stops without being asked, the last {@link LOG_TAIL_LINES} lines
   * and this path are printed. Without it the runtime's output is inherited, as before.
   */
  readonly logFile?: string;
  /** Also stream the runtime's output to the terminal while it is written to `logFile`. */
  readonly verbose?: boolean;
}

/** How much of the runtime log a failure prints. */
const LOG_TAIL_LINES = 20;

/** The last lines of the log, for a failure; empty when it cannot be read. */
function logTail(file: string): string {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-LOG_TAIL_LINES).join('\n');
  } catch {
    return '';
  }
}

/** Where the conversation with the runtime is: what it may say next. */
type ProtocolState = 'starting' | 'ready' | 'signed-in';

function protocolBroken(detail: string): CommandRefusedError {
  return new CommandRefusedError(`the local runtime broke the protocol: ${detail}`);
}

/** The paths of a refused message's issues — never the values, which may hold a token. */
function issuePaths(error: z.ZodError): string {
  const paths = error.issues.map((issue) => issue.path.map(String).join('.') || '(root)');
  return [...new Set(paths)].join(', ');
}

/** The port a URL names, its scheme's default when it names none. */
function urlPort(text: string): number {
  const url = new URL(text);
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stoppedText(code: number | null, signal: NodeJS.Signals | null): string {
  return signal === null
    ? `the local runtime stopped (exit code ${String(code)})`
    : `the local runtime stopped (signal ${signal})`;
}

/**
 * Fork the local runtime, send it `start`, and follow it until it exits. Every message it sends
 * is parsed against the contract and must arrive in order — `ready`, then `credential` — with
 * `failed` allowed at any time; anything else stops it as a protocol violation. The credential — a
 * workspace API key for the local workspace — is stored for `localProjectUrl(port)` with
 * `saveLocalApiKey` (its own file, beside `credentials.json`) and never printed.
 *
 * The promise never resolves: it rejects when the runtime exits — with the runtime's own failure,
 * a protocol or version refusal, the exit code it stopped with, or (after the signal aborts, which
 * `main` reports as an interruption) once the runtime has stopped.
 */
export function superviseLocalRuntime(options: SuperviseOptions): Promise<never> {
  const { io, signal, start, hooks } = options;
  const port = start.environment.port;
  const expectedOrigin = localProjectUrl(port);

  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new CommandRefusedError('interrupted before the local runtime started'));
      return;
    }
    const { logFile } = options;
    let log: ReturnType<typeof createWriteStream> | undefined;
    if (logFile !== undefined) {
      try {
        mkdirSync(path.dirname(logFile), { recursive: true });
      } catch (error) {
        reject(new CommandRefusedError(`could not write the runtime log: ${errorText(error)}`));
        return;
      }
      log = createWriteStream(logFile, { flags: 'w' });
    }
    const child: ChildProcess = fork(options.launchPath, [], {
      cwd: options.cwd,
      // Every secret the project names stays in aw: the runtime gets it only through the API (SD17).
      env: withoutNames(io.env, start.environment.withheld ?? []),
      stdio:
        log === undefined
          ? ['inherit', 'inherit', 'inherit', 'ipc']
          : ['inherit', 'pipe', 'pipe', 'ipc'],
    });
    // The pipes close after the exit; a grandchild that keeps them open must not keep `aw dev` up.
    const stdioClosed = new Promise<void>((resolve) => {
      child.once('close', () => {
        resolve();
      });
    });
    // The log hides the runtime's output; the ready screen says where the console password is kept,
    // and the password itself is never printed (BH061-011).
    child.stdout?.on('data', (chunk: Buffer) => {
      log?.write(chunk);
      if (options.verbose === true) io.stdout(chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      log?.write(chunk);
      if (options.verbose === true) io.stderr(chunk.toString('utf8'));
    });

    let state: ProtocolState = 'starting';
    let failure: Error | undefined;
    let stopping = false;
    let killTimer: NodeJS.Timeout | undefined;
    // Each message's work runs after the previous one's, so a hook never overlaps the next step.
    let queue: Promise<void> = Promise.resolve();

    /**
     * Ask the runtime to stop, then kill it after the grace. Closing the IPC channel is the request
     * the runtime honours on every platform; on Windows `kill('SIGINT')` would terminate it outright
     * and skip its clean shutdown, so `SIGINT` is sent only where it is a real signal.
     */
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      if (child.connected) child.disconnect();
      if (process.platform !== 'win32') child.kill('SIGINT');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, LOCAL_RUNTIME_STOP_GRACE_MS);
    };

    /** Stop the runtime because of `error`; the first reason is the one reported. */
    const fail = (error: Error): void => {
      failure ??= error;
      stop();
    };

    // A log that cannot be opened or written (read-only directory, full disk) stops the runtime
    // with a refusal; `log.end(finish)` still settles the promise.
    log?.on('error', (error) => {
      fail(new CommandRefusedError(`could not write the runtime log: ${error.message}`));
    });

    const onAbort = (): void => {
      stop();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const handle = async (message: LocalRuntimeChildMessage): Promise<void> => {
      switch (message.type) {
        case 'failed':
          fail(new CommandRefusedError(message.message));
          return;
        case 'ready': {
          if (state !== 'starting') {
            fail(protocolBroken('ready was sent twice'));
            return;
          }
          if (message.contractsVersion !== CONTRACTS_VERSION) {
            fail(
              new CommandRefusedError(
                `the local runtime speaks contracts ${message.contractsVersion}, but aw ${AW_VERSION} speaks contracts ${CONTRACTS_VERSION}; reinstall ${EMBEDDED_PACKAGE}`,
                EMBEDDED_INSTALL_FIX,
              ),
            );
            return;
          }
          // The contract admits any loopback host; the port is what must be the project's.
          if (urlPort(message.url) !== port) {
            fail(
              protocolBroken(`ready.url is not on port ${String(port)}, which aw dev asked for`),
            );
            return;
          }
          state = 'ready';
          await hooks.onReady?.({ url: message.url });
          return;
        }
        case 'credential': {
          if (state !== 'ready') {
            fail(
              protocolBroken(
                state === 'starting'
                  ? 'credential was sent before ready'
                  : 'credential was sent twice',
              ),
            );
            return;
          }
          state = 'signed-in';
          await saveLocalApiKey(io.homeDir, expectedOrigin, {
            apiKey: message.token,
            expiresAt: message.expiresAt,
            workspaceId: message.workspaceId,
            workspaceSlug: message.workspaceSlug,
          });
          await hooks.onSignedIn?.({
            baseUrl: expectedOrigin,
            apiKey: message.token,
            workspaceSlug: message.workspaceSlug,
          });
          return;
        }
        default: {
          const unreachable: never = message;
          fail(protocolBroken(`unknown message ${typeof unreachable}`));
        }
      }
    };

    child.on('message', (raw: unknown) => {
      if (stopping) return;
      const parsed = LocalRuntimeChildMessageSchema.safeParse(raw);
      if (!parsed.success) {
        fail(protocolBroken(issuePaths(parsed.error)));
        return;
      }
      const message = parsed.data;
      queue = queue.then(async () => {
        if (stopping) return;
        try {
          await handle(message);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });

    child.once('error', (error) => {
      // `fork` could not start the process, or a signal could not be delivered.
      fail(new CommandRefusedError(`could not run the local runtime: ${error.message}`));
    });

    child.once('exit', (code, exitSignal) => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      const reason =
        failure ??
        (signal.aborted
          ? new CommandRefusedError('interrupted')
          : new CommandRefusedError(stoppedText(code, exitSignal)));
      // Let a hook that is still running (a request the abort cancels) finish before answering.
      void queue.finally(() => {
        const finish = (): void => {
          if (logFile !== undefined && !signal.aborted && options.verbose !== true) {
            const tail = logTail(logFile);
            io.stderr(`${tail === '' ? '' : `${tail}\n`}full log: ${logFile}\n`);
          }
          reject(reason);
        };
        // Wait for the last output, then for the file, before reading it.
        if (log === undefined) finish();
        else {
          void Promise.race([stdioClosed, new Promise((done) => setTimeout(done, 1000))]).then(
            () => {
              log.end(finish);
            },
          );
        }
      });
    });

    child.send(start, (error) => {
      if (error !== null)
        fail(new CommandRefusedError('could not send start to the local runtime'));
    });
  });
}
