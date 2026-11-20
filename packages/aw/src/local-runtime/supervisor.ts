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
  /** Issue #1506: the runtime's loopback PostgreSQL, for a generated app; never printed. */
  readonly databaseUrl?: string;
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
  /** The local workspace's id: what an app's identity assertions name (issue #1506). */
  readonly workspaceId: string;
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

type RuntimeLog = ReturnType<typeof createWriteStream>;

/** How long to wait for a grandchild that keeps the runtime's pipes open after the runtime exits. */
const STDIO_CLOSE_WAIT_MS = 1000;

/** Open the runtime log, replacing the previous one; `undefined` when no log file was asked for. */
function openRuntimeLog(logFile: string | undefined): RuntimeLog | undefined {
  if (logFile === undefined) return undefined;
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
  } catch (error) {
    throw new CommandRefusedError(`could not write the runtime log: ${errorText(error)}`);
  }
  return createWriteStream(logFile, { flags: 'w' });
}

function forkRuntime(options: SuperviseOptions, log: RuntimeLog | undefined): ChildProcess {
  return fork(options.launchPath, [], {
    cwd: options.cwd,
    // Every secret the project names stays in aw: the runtime gets it only through the API (SD17).
    env: withoutNames(options.io.env, options.start.environment.withheld ?? []),
    stdio:
      log === undefined
        ? ['inherit', 'inherit', 'inherit', 'ipc']
        : ['inherit', 'pipe', 'pipe', 'ipc'],
  });
}

/**
 * The log hides the runtime's output; the ready screen says where the console password is kept,
 * and the password itself is never printed (BH061-011).
 */
function routeRuntimeOutput(
  child: ChildProcess,
  log: RuntimeLog | undefined,
  options: SuperviseOptions,
): void {
  const route =
    (print: (text: string) => void) =>
    (chunk: Buffer): void => {
      log?.write(chunk);
      if (options.verbose === true) print(chunk.toString('utf8'));
    };
  child.stdout?.on('data', route(options.io.stdout));
  child.stderr?.on('data', route(options.io.stderr));
}

/** Resolves once the child's pipes close, which is after the exit. */
function whenStdioClosed(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    child.once('close', () => {
      resolve();
    });
  });
}

/** One supervised run: the protocol state, the reason to stop, and the stop machinery. */
class RuntimeRun {
  private state: ProtocolState = 'starting';
  private failure: Error | undefined;
  private stopping = false;
  private killTimer: NodeJS.Timeout | undefined;
  // Each message's work runs after the previous one's, so a hook never overlaps the next step.
  private queue: Promise<void> = Promise.resolve();
  private readonly port: number;
  private readonly expectedOrigin: string;

  constructor(
    private readonly child: ChildProcess,
    private readonly options: SuperviseOptions,
  ) {
    this.port = options.start.environment.port;
    this.expectedOrigin = localProjectUrl(this.port);
  }

  /**
   * Ask the runtime to stop, then kill it after the grace. Closing the IPC channel is the request
   * the runtime honours on every platform; on Windows `kill('SIGINT')` would terminate it outright
   * and skip its clean shutdown, so `SIGINT` is sent only where it is a real signal.
   */
  readonly stop = (): void => {
    if (this.stopping) return;
    this.stopping = true;
    if (this.child.connected) this.child.disconnect();
    if (process.platform !== 'win32') this.child.kill('SIGINT');
    this.killTimer = setTimeout(() => {
      this.child.kill('SIGKILL');
    }, LOCAL_RUNTIME_STOP_GRACE_MS);
  };

  /** Stop the runtime because of `error`; the first reason is the one reported. */
  readonly fail = (error: Error): void => {
    this.failure ??= error;
    this.stop();
  };

  /** Parse a raw IPC message and queue its work after the previous message's. */
  receive(raw: unknown): void {
    if (this.stopping) return;
    const parsed = LocalRuntimeChildMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.fail(protocolBroken(issuePaths(parsed.error)));
      return;
    }
    const message = parsed.data;
    this.queue = this.queue.then(async () => {
      if (this.stopping) return;
      try {
        await this.handle(message);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** What the run ends with: the first failure, else why the runtime stopped. */
  stoppedReason(code: number | null, exitSignal: NodeJS.Signals | null, aborted: boolean): Error {
    if (this.failure !== undefined) return this.failure;
    return new CommandRefusedError(aborted ? 'interrupted' : stoppedText(code, exitSignal));
  }

  /** Cancel the pending kill and wait for a hook that is still running (a request the abort cancels). */
  settled(): Promise<void> {
    if (this.killTimer !== undefined) clearTimeout(this.killTimer);
    return this.queue.finally(() => undefined);
  }

  private async handle(message: LocalRuntimeChildMessage): Promise<void> {
    switch (message.type) {
      case 'failed':
        this.fail(new CommandRefusedError(message.message));
        return;
      case 'ready':
        await this.handleReady(message);
        return;
      case 'credential':
        await this.handleCredential(message);
        return;
      default: {
        const unreachable: never = message;
        this.fail(protocolBroken(`unknown message ${typeof unreachable}`));
      }
    }
  }

  private async handleReady(message: Extract<LocalRuntimeChildMessage, { type: 'ready' }>) {
    if (this.state !== 'starting') {
      this.fail(protocolBroken('ready was sent twice'));
      return;
    }
    if (message.contractsVersion !== CONTRACTS_VERSION) {
      this.fail(
        new CommandRefusedError(
          `the local runtime speaks contracts ${message.contractsVersion}, but aw ${AW_VERSION} speaks contracts ${CONTRACTS_VERSION}; reinstall ${EMBEDDED_PACKAGE}`,
          EMBEDDED_INSTALL_FIX,
        ),
      );
      return;
    }
    // The contract admits any loopback host; the port is what must be the project's.
    if (urlPort(message.url) !== this.port) {
      this.fail(
        protocolBroken(`ready.url is not on port ${String(this.port)}, which aw dev asked for`),
      );
      return;
    }
    this.state = 'ready';
    await this.options.hooks.onReady?.({
      url: message.url,
      ...(message.databaseUrl === undefined ? {} : { databaseUrl: message.databaseUrl }),
    });
  }

  private async handleCredential(
    message: Extract<LocalRuntimeChildMessage, { type: 'credential' }>,
  ) {
    if (this.state !== 'ready') {
      this.fail(
        protocolBroken(
          this.state === 'starting'
            ? 'credential was sent before ready'
            : 'credential was sent twice',
        ),
      );
      return;
    }
    this.state = 'signed-in';
    await saveLocalApiKey(this.options.io.homeDir, this.expectedOrigin, {
      apiKey: message.token,
      expiresAt: message.expiresAt,
      workspaceId: message.workspaceId,
      workspaceSlug: message.workspaceSlug,
    });
    await this.options.hooks.onSignedIn?.({
      baseUrl: this.expectedOrigin,
      apiKey: message.token,
      workspaceId: message.workspaceId,
      workspaceSlug: message.workspaceSlug,
    });
  }
}

/** Print the log's tail for a runtime that stopped without being asked (issue #692). */
function reportUnaskedStop(options: SuperviseOptions): void {
  const { logFile } = options;
  if (logFile === undefined || options.signal.aborted || options.verbose === true) return;
  const tail = logTail(logFile);
  options.io.stderr(`${tail === '' ? '' : `${tail}\n`}full log: ${logFile}\n`);
}

/** Wait for the last output, then for the file, before `finish` reads it. */
async function closeRuntimeLog(
  log: RuntimeLog | undefined,
  stdioClosed: Promise<void>,
  finish: () => void,
): Promise<void> {
  if (log === undefined) {
    finish();
    return;
  }
  await Promise.race([stdioClosed, new Promise((done) => setTimeout(done, STDIO_CLOSE_WAIT_MS))]);
  log.end(finish);
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
  return new Promise<never>((_resolve, reject) => {
    const { signal } = options;
    if (signal.aborted) {
      reject(new CommandRefusedError('interrupted before the local runtime started'));
      return;
    }
    let log: RuntimeLog | undefined;
    try {
      log = openRuntimeLog(options.logFile);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(errorText(error)));
      return;
    }
    const child = forkRuntime(options, log);
    // The pipes close after the exit; a grandchild that keeps them open must not keep `aw dev` up.
    const stdioClosed = whenStdioClosed(child);
    routeRuntimeOutput(child, log, options);

    const run = new RuntimeRun(child, options);
    // A log that cannot be opened or written (read-only directory, full disk) stops the runtime
    // with a refusal; `log.end(finish)` still settles the promise.
    log?.on('error', (error) => {
      run.fail(new CommandRefusedError(`could not write the runtime log: ${error.message}`));
    });
    signal.addEventListener('abort', run.stop, { once: true });

    child.on('message', (raw: unknown) => {
      run.receive(raw);
    });
    child.once('error', (error) => {
      // `fork` could not start the process, or a signal could not be delivered.
      run.fail(new CommandRefusedError(`could not run the local runtime: ${error.message}`));
    });
    child.once('exit', (code, exitSignal) => {
      signal.removeEventListener('abort', run.stop);
      const reason = run.stoppedReason(code, exitSignal, signal.aborted);
      void run.settled().then(() =>
        closeRuntimeLog(log, stdioClosed, () => {
          reportUnaskedStop(options);
          reject(reason);
        }),
      );
    });
    child.send(options.start, (error) => {
      if (error !== null)
        run.fail(new CommandRefusedError('could not send start to the local runtime'));
    });
  });
}
