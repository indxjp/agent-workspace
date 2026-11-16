import { DATABASE_PORT } from './launcher-ports.test-support.js';

import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LocalRuntimeChildMessageSchema,
  type LocalRuntimeChildMessage,
  type LocalRuntimeCredentialMessage,
  type LocalRuntimeReadyMessage,
  type LocalRuntimeStartMessage,
} from '@indx-workspace/contracts/local-runtime';
import { expect } from 'vitest';
import { type Ports } from './launcher-ports.test-support.js';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
export const bin = path.join(packageDirectory, 'dist', 'bin.js');

/** How long one runtime may take to answer `start` with `credential`: Postgres, migrations, Next. */
export const START_TIMEOUT_MS = 240_000;
/** How long a runtime may take to exit after SIGINT. */
export const STOP_TIMEOUT_MS = 60_000;

/**
 * Variables the runtime sets itself (C1, the managed workspace variables and the local secrets).
 * A value inherited from the test process would be refused as a conflict, or would silently point
 * the runtime at another database, so the child starts without any of them, as under `aw dev`.
 */
const INHERITED_VARIABLES_REMOVED = new Set([
  'AW_DATA_DIR',
  'AW_DEPLOYMENT_DEFAULT_MODELS',
  'AW_DEPLOYMENT_POSTURE',
  'AW_FILE_STORAGE_ROOT',
  'AW_LOCAL_SURFACE_SESSIONS',
  'AW_SESSION_MIRROR_URL',
  'AW_SESSION_TRANSCRIPT_ROOT',
  'AW_SKILL_STORAGE_ROOT',
  'AW_STORAGE_URL',
  'BOOTSTRAP_ADMIN',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'DATABASE_URL',
  'GATEWAY_TOKEN_SECRET',
  'HOST',
  'MASTER_ENCRYPTION_KEY',
  'MIGRATIONS_DIR',
  'MODEL_GATEWAY_URL',
  'NODE_ENV',
  'PORT',
  'RUNNER_URL',
  'RUNTIME_DRIVER',
  'SESSION_SECRET',
  'WORKSPACE_SLUG',
]);

/** One forked runtime: what it said over IPC, what it printed, and how it ended. */
export class ForkedRuntime {
  readonly messages: LocalRuntimeChildMessage[] = [];
  readonly invalidMessages: unknown[] = [];
  stdout = '';
  stderr = '';
  exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null = null;
  private readonly child: ChildProcess;
  private readonly exited: Promise<void>;
  private readonly waiters = new Set<() => void>();

  constructor(projectDir: string, ports: Ports, options: { readonly detached?: boolean } = {}) {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || INHERITED_VARIABLES_REMOVED.has(key)) continue;
      if (key.startsWith('VITEST')) continue;
      environment[key] = value;
    }
    environment['GATEWAY_PORT'] = String(ports.gateway);
    environment['RUNNER_PORT'] = String(ports.runner);
    environment['AW_DATABASE_PORT'] = String(DATABASE_PORT);

    this.child = fork(bin, [], {
      cwd: projectDir,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      // A detached launcher leads its own process group, as a job a terminal started does.
      detached: options.detached === true,
    });
    this.child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      this.stdout += chunk;
      this.notify();
    });
    this.child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    this.child.on('message', (message: unknown) => {
      const parsed = LocalRuntimeChildMessageSchema.safeParse(message);
      if (parsed.success) this.messages.push(parsed.data);
      else this.invalidMessages.push(message);
      this.notify();
    });
    this.exited = new Promise<void>((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.exit = { code, signal };
        this.notify();
        resolve();
      });
    });
  }

  send(message: LocalRuntimeStartMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.child.send(message, (error) => {
        if (error === null) resolve();
        else reject(error);
      });
    });
  }

  /** Resolve once `ready` and then `credential` arrived; reject on `failed`, an exit or a timeout. */
  async started(): Promise<{
    readonly ready: LocalRuntimeReadyMessage;
    readonly credential: LocalRuntimeCredentialMessage;
  }> {
    await this.until(
      () =>
        this.invalidMessages.length > 0 ||
        this.exit !== null ||
        this.messages.some(({ type }) => type === 'failed' || type === 'credential'),
      START_TIMEOUT_MS,
      'ready and credential',
    );
    if (this.invalidMessages.length > 0) {
      throw new Error('the runtime sent a message LocalRuntimeChildMessageSchema refuses');
    }
    const failed = this.messages.find((message) => message.type === 'failed');
    if (failed !== undefined) {
      const collision = failed.message.includes(String(DATABASE_PORT))
        ? ` The embedded PostgreSQL port ${String(DATABASE_PORT)} was taken after this file ` +
          'found it free: run again.'
        : '';
      throw new Error(`the runtime sent failed: ${failed.message}.${collision}`);
    }
    const [ready, credential] = this.messages;
    if (ready?.type !== 'ready' || credential?.type !== 'credential') {
      throw new Error(
        `expected ready then credential, got [${this.messages.map(({ type }) => type).join(', ')}]` +
          (this.exit === null ? '' : `; the runtime exited ${JSON.stringify(this.exit)}`),
      );
    }
    return { ready, credential };
  }

  /**
   * Resolve once the sign-in line is on stdout. The launcher prints it after sending `credential`,
   * and the pipe may deliver it after the IPC message.
   */
  async signInPrinted(): Promise<string> {
    await this.until(
      () => this.exit !== null || this.stdout.includes('Sign in at '),
      STOP_TIMEOUT_MS,
      'the sign-in line',
    );
    return this.stdout;
  }

  /**
   * Send SIGINT and resolve with how the runtime exited. Windows cannot deliver SIGINT to a child
   * (`kill` terminates it outright), so there the IPC channel is closed instead, the other shutdown
   * trigger the launcher handles the same way.
   */
  async interrupt(): Promise<{ readonly code: number | null; readonly signal: string | null }> {
    if (process.platform === 'win32') this.child.disconnect();
    else this.child.kill('SIGINT');
    await this.until(() => this.exit !== null, STOP_TIMEOUT_MS, 'exit after SIGINT');
    return this.exit ?? { code: null, signal: null };
  }

  /** The launcher's pid, which is also its process group's id when it was forked detached. */
  get pid(): number {
    const { pid } = this.child;
    if (pid === undefined) throw new Error('the runtime was not spawned');
    return pid;
  }

  /**
   * Send SIGINT to the launcher's whole process group, as a terminal's Ctrl+C does to its
   * foreground job, and resolve with how the runtime exited. Windows has no process-group signal,
   * so there the IPC channel is closed instead, as {@link interrupt} does.
   */
  async interruptGroup(signal: 'SIGINT' | 'SIGHUP' = 'SIGINT'): Promise<{
    readonly code: number | null;
    readonly signal: string | null;
  }> {
    if (process.platform === 'win32') this.child.disconnect();
    else process.kill(-this.pid, signal);
    await this.until(() => this.exit !== null, STOP_TIMEOUT_MS, `exit after a group ${signal}`);
    return this.exit ?? { code: null, signal: null };
  }

  /** Resolve with how the runtime exited, once it has, on its own. */
  async ended(
    timeoutMs: number,
  ): Promise<{ readonly code: number | null; readonly signal: string | null }> {
    await this.until(() => this.exit !== null, timeoutMs, 'the runtime to exit');
    return this.exit ?? { code: null, signal: null };
  }

  /** Kill whatever is still running; for `afterAll`, whatever a failed test left behind. */
  async dispose(): Promise<void> {
    if (this.exit !== null) return;
    this.child.kill('SIGKILL');
    await this.exited;
  }

  private notify(): void {
    for (const waiter of this.waiters) waiter();
  }

  private until(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!condition()) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}`));
      }, timeoutMs);
      this.waiters.add(check);
      check();
    });
  }
}

/**
 * What a clean stop must not print (S1-25, #510): the revoke warning, an uncaught error, and the
 * pool's report of a connection PostgreSQL terminated, which means it stopped before a pool closed.
 */
const UNCLEAN_STOP_OUTPUT = [
  'could not be revoked',
  'terminating connection due to administrator command',
  '[db] a database connection failed',
  'Uncaught',
  'Unhandled',
] as const;

export function expectNoUncleanStopOutput(stderr: string): void {
  for (const forbidden of UNCLEAN_STOP_OUTPUT) {
    expect(stderr, `stderr names ${forbidden}`).not.toContain(forbidden);
  }
}

/** {@link expectNoUncleanStopOutput}, and no stack trace at all: for a runtime that ran nothing. */
export function expectCleanStop(stderr: string): void {
  expectNoUncleanStopOutput(stderr);
  expect(stderr, 'stderr holds a stack trace').not.toMatch(/^\s+at /mu);
}

/** The postmaster's pid: the first line of `postmaster.pid` in the embedded data directory. */
export function readPostmasterPid(projectDir: string): number {
  const file = path.join(projectDir, '.agent-workspace', 'postgres', 'postmaster.pid');
  const pid = Number.parseInt(readFileSync(file, 'utf8').split('\n')[0] ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('postmaster.pid names no pid');
  return pid;
}

/** The port the postmaster listens on: the fourth line of `postmaster.pid`. */
export function readPostmasterPort(projectDir: string): number {
  const file = path.join(projectDir, '.agent-workspace', 'postgres', 'postmaster.pid');
  return Number.parseInt(readFileSync(file, 'utf8').split('\n')[3] ?? '', 10);
}

/** The process group of `pid`: field 5 of `/proc/<pid>/stat` on Linux, `ps` elsewhere. */
export function processGroupOf(pid: number): number {
  let group: string;
  if (process.platform === 'linux') {
    const stat = readFileSync(path.join('/proc', String(pid), 'stat'), 'utf8');
    // `pid (comm) state ppid pgrp …`: comm may hold spaces, so read on from the last `)`.
    group = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2] ?? '';
  } else {
    group = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  }
  const parsed = Number.parseInt(group, 10);
  if (!Number.isInteger(parsed)) throw new Error(`no process group for pid ${String(pid)}`);
  return parsed;
}

/** Whether a process with `pid` exists (signal 0 checks without signalling). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}
