/**
 * S1-11 (issue #449, ADR-0109): the published launcher end to end. It forks the built
 * `dist/bin.js` with an IPC channel, as `aw dev` does, in a fresh project directory, and speaks the
 * `@indx-workspace/contracts/local-runtime` protocol to it: `start` → `ready` → `credential`.
 *
 * It reads what `pnpm --filter @indx-workspace/embedded build` wrote (the Nx `test` target
 * depends on `build`) and fails, never skips, when that output is missing. The runtime starts its
 * own embedded PostgreSQL on the fixed port 25432 under `<projectDir>/.agent-workspace/postgres`
 * (its web port is an ephemeral one, from 32768 up, so the database port derived from it, #664,
 * lies past 49151 and keeps 25432)
 * (outside every OS ephemeral range, #556); a database already listening there (another embedded
 * runtime on this host) fails the first start, before anything starts, with a `failed` naming
 * `port 25432 (embedded PostgreSQL) is already in use: …` and what to do (#660), never a retry or a
 * hang, which the last test proves.
 *
 * The credential is a workspace API key (S1-21, issue #500): it is accepted by `/api/me` and by the
 * control-plane routes `aw dev` calls, such as `/api/model-connections`, which the CLI user token
 * the runtime used to issue was refused on (ADR-0083 §4).
 *
 * The runtime is started twice on the same project directory. The second start proves that the
 * secrets file is reused byte for byte, that the password is never printed (BH061-011), and
 * that the first key is refused with 401. The second start also revokes any key a crashed run left
 * behind, so the test reads the first key's `api_keys` row from the embedded database and checks
 * that it was revoked before the first runtime had exited: by the stop, not by the next start.
 *
 * S1-22 (issue #504): the start also makes a runtime profile named `local`, on the `local` driver,
 * the workspace default. An agent created from a version that names no runtime profile — what
 * `aw push` always writes — is materialised with it, and its run is accepted with `202` and gets
 * past runtime resolution to the runner, where the model call cannot succeed because the model
 * connection points at a loopback port nothing listens on; the test then interrupts it.
 *
 * S1-23 (issue #506): the launcher also sets `AW_DEPLOYMENT_DEFAULT_MODELS`, contract C7's deployment
 * default model and the last layer of the run model ladder (ADR-0103 amendment). An agent whose
 * version names the `default` connection but no model — what `@indx-workspace/sdk` writes for
 * `model: 'default'` — is accepted with `202` and runs on `claude-sonnet-4-5`, unvalidated because
 * discovery cannot read the unreachable model host, instead of `422 model_connection_unresolved`.
 *
 * The test then deletes that default (the agent row's foreign key sets its profile to `NULL`, and
 * its run is refused with `422 agent_runtime_profile_missing`). The second start makes a new
 * `local` default, keeps exactly one `local` profile, and attaches it to the agent, whose run is
 * accepted again with no new push and no pointer move (the S1-22 review's restart case).
 *
 * S1-24 (issue #509): the first run pushes an agent whose version has a surface `main` (pointed
 * `local`, C9), owned by the bootstrap admin's membership principal and not by the per-run key.
 * Just before the stop, the test sets another agent's owner back to the first key's own principal
 * through the embedded database, which is what a project pushed before the fix holds (the database
 * runs only while a runtime does, so this is the last moment it can). After the restart, which
 * revoked the first key, the widget's `POST /p/s/main/sessions` still opens a session, and the
 * repair at start moved the simulated row to the bootstrap admin.
 *
 * S1-25 (issue #510, ADR-0112): a terminal's Ctrl+C sends SIGINT to the whole foreground process
 * group. The embedded PostgreSQL postmaster used to sit in the launcher's group, so it shut down
 * while the launcher was still revoking its key. A second describe forks the launcher `detached`, so
 * it leads its own group as a terminal job does, and signals that whole group: the postmaster must
 * be in a group of its own, the launcher must exit 0 with no revoke warning and no pg error, and the
 * postmaster and its port must be gone afterwards. The restart on the same project is then ended by
 * a SIGHUP to its group, a closed terminal, with the same result. On Windows the IPC channel is
 * closed instead.
 */
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTRACTS_VERSION } from '@indx-workspace/contracts';
import { AgentResourceSchema } from '@indx-workspace/contracts/agents';
import {
  CreateAgentFromVersionResponseSchema,
  type CreateAgentFromVersionRequestInput,
} from '@indx-workspace/contracts/agent-versions';
import { API_KEY_PATTERN } from '@indx-workspace/contracts/api-keys';
import { ModelConnectionListResponseSchema } from '@indx-workspace/contracts/models';
import {
  LocalRuntimeChildMessageSchema,
  type LocalRuntimeChildMessage,
  type LocalRuntimeCredentialMessage,
  type LocalRuntimeReadyMessage,
  type LocalRuntimeStartMessage,
} from '@indx-workspace/contracts/local-runtime';
import {
  isTerminalRunStatus,
  RunResponseSchema,
  StartRunResponseSchema,
  type RunResource,
} from '@indx-workspace/contracts/runs';
import { RuntimeProfileListResponseSchema } from '@indx-workspace/contracts/runtimes';
import { SurfaceSessionResponseSchema } from '@indx-workspace/contracts/surfaces';
import { MeResponseSchema } from '@indx-workspace/contracts/team';
import { openDatabaseRoot } from '@agent-workspace/core/db';
import { connect, readDatabaseConfig } from '@agent-workspace/core/db/unscoped';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(packageDirectory, 'dist', 'bin.js');

/** How long one runtime may take to answer `start` with `credential`: Postgres, migrations, Next. */
const START_TIMEOUT_MS = 240_000;
/** How long a runtime may take to exit after SIGINT. */
const STOP_TIMEOUT_MS = 60_000;
const EMBEDDED_DATABASE_PORT = 25432;
/** How long a runtime whose database port is taken may take to answer `failed` and exit. */
const PORT_TAKEN_TIMEOUT_MS = 60_000;
const BOOTSTRAP_ADMIN = 'admin@localhost.test';
/** The fixed loopback-only role `embedded-db.ts` creates for the embedded database. */
const EMBEDDED_DATABASE_URL = `postgresql://agent_workspace:agent_workspace_local@127.0.0.1:${String(EMBEDDED_DATABASE_PORT)}/postgres`;
/** `LOCAL_RUNTIME_API_KEY_NAME_PREFIX` in `apps/web/server/cli-auth/local-credential.ts`. */
const LOCAL_KEY_NAME_PREFIX = 'aw dev local runtime ';

/**
 * Listen on `127.0.0.1:port` and keep listening. When something else (another embedded runtime on
 * this host) already holds the port, resolve with null: the port is taken either way.
 */
function holdPort(port: number): Promise<Server | null> {
  return new Promise<Server | null>((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => {
      if ('code' in error && error.code === 'EADDRINUSE') resolve(null);
      else reject(error);
    });
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

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

const LocalSecretsFileSchema = z.looseObject({ BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12) });

/**
 * Three distinct OS-assigned loopback ports. All probes listen at once before any is released, so
 * the OS cannot hand the same port out twice in a row (it recycles a just-closed one), which made
 * two of the runtime's listeners collide with `port <n> is already in use` (#857).
 */
async function freePorts(): Promise<{ web: number; gateway: number; runner: number }> {
  const probes = [createServer(), createServer(), createServer()];
  try {
    const [web, gateway, runner] = await Promise.all(
      probes.map(
        async (probe) =>
          new Promise<number>((resolve, reject) => {
            probe.once('error', reject);
            probe.listen(0, '127.0.0.1', () => {
              const address = probe.address();
              if (address !== null && typeof address === 'object') resolve(address.port);
              else reject(new Error('the probe server reported no port'));
            });
          }),
      ),
    );
    return { web: web ?? 0, gateway: gateway ?? 0, runner: runner ?? 0 };
  } finally {
    await Promise.all(
      probes.map(async (probe) => new Promise<void>((resolve) => probe.close(() => resolve()))),
    );
  }
}

interface Ports {
  readonly web: number;
  readonly gateway: number;
  readonly runner: number;
}

/** One forked runtime: what it said over IPC, what it printed, and how it ended. */
class ForkedRuntime {
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
      const collision = failed.message.includes(String(EMBEDDED_DATABASE_PORT))
        ? ` The embedded PostgreSQL port ${String(EMBEDDED_DATABASE_PORT)} is taken: stop the ` +
          'other embedded runtime on this host (pnpm start:embedded, aw dev) and run again.'
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

function expectNoUncleanStopOutput(stderr: string): void {
  for (const forbidden of UNCLEAN_STOP_OUTPUT) {
    expect(stderr, `stderr names ${forbidden}`).not.toContain(forbidden);
  }
}

/** {@link expectNoUncleanStopOutput}, and no stack trace at all: for a runtime that ran nothing. */
function expectCleanStop(stderr: string): void {
  expectNoUncleanStopOutput(stderr);
  expect(stderr, 'stderr holds a stack trace').not.toMatch(/^\s+at /mu);
}

/** The postmaster's pid: the first line of `postmaster.pid` in the embedded data directory. */
function readPostmasterPid(projectDir: string): number {
  const file = path.join(projectDir, '.agent-workspace', 'postgres', 'postmaster.pid');
  const pid = Number.parseInt(readFileSync(file, 'utf8').split('\n')[0] ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('postmaster.pid names no pid');
  return pid;
}

/** The process group of `pid`: field 5 of `/proc/<pid>/stat` on Linux, `ps` elsewhere. */
function processGroupOf(pid: number): number {
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
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

function getMe(url: string, token: string): Promise<Response> {
  return fetch(new URL('/api/me', url), { headers: { authorization: `Bearer ${token}` } });
}

function getModelConnections(url: string, token: string): Promise<Response> {
  return fetch(new URL('/api/model-connections', url), {
    headers: { authorization: `Bearer ${token}` },
  });
}

/** How long a started run may take to settle: terminal, or running past its launch. */
const RUN_TIMEOUT_MS = 120_000;

/**
 * How long a run must stay `running` to count as launched. A run refused while it is prepared
 * (runtime resolution included) is marked `running` and concluded `failed` in the same step, so a
 * run still `running` this long after was handed to the runner. The model call that follows retries
 * against a port nothing serves, so the run is then interrupted rather than waited for.
 */
const LAUNCHED_AFTER_RUNNING_MS = 5_000;

/**
 * A base URL on loopback that nothing listens on (port 9, discard): model discovery cannot read the
 * model list, so the explicit model passes unvalidated (`resolveModelForRun`), and the run fails at
 * the model call — after runtime resolution, which is what this test is about.
 */
const UNREACHABLE_MODEL_BASE_URL = 'http://127.0.0.1:9';

/** Messages a run must never fail with once the workspace has a default runtime profile. */
const RUNTIME_RESOLUTION_FAILURES = [
  'agent_runtime_profile_missing',
  'selects unavailable driver',
  'Test Runtime has not passed',
  'selects unsupported driver',
  'no launch target is configured',
  'cannot run on driver',
  // The safe public text of any failure while the run is prepared, runtime resolution included.
  'The run request could not be prepared',
] as const;

function authorised(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  };
}

async function listRuntimeProfiles(url: string, token: string) {
  const response = await fetch(new URL('/api/runtime-profiles', url), authorised(token));
  expect(response.status).toBe(200);
  return RuntimeProfileListResponseSchema.parse(await response.json()).runtimeProfiles;
}

async function getAgentProfileId(url: string, token: string, agentId: string) {
  const response = await fetch(new URL(`/api/agents/${agentId}`, url), authorised(token));
  expect(response.status).toBe(200);
  return AgentResourceSchema.parse(await response.json()).runtimeProfileId;
}

function startRun(url: string, token: string, agentId: string): Promise<Response> {
  return fetch(
    new URL(`/api/agents/${agentId}/runs`, url),
    authorised(token, { method: 'POST', body: JSON.stringify({ prompt: 'Say hello.' }) }),
  );
}

/**
 * Start a run of `agentId`, expect `202`, and answer it once it is terminal or launched; a launched
 * run is interrupted, since its model call cannot succeed.
 */
async function runPastResolution(url: string, token: string, agentId: string) {
  const started = await startRun(url, token, agentId);
  const startBody: unknown = await started.json();
  expect(started.status, JSON.stringify(startBody)).toBe(202);
  const { run } = StartRunResponseSchema.parse(startBody);
  const ended = await settledRun(url, token, run.id);
  if (ended.status === 'running') {
    const interrupted = await fetch(
      new URL(`/api/runs/${run.id}/interrupt`, url),
      authorised(token, { method: 'POST' }),
    );
    expect(interrupted.status).toBe(200);
  }
  return ended;
}

/** The model fields of a version's agent: an explicit model, or a connection and no model. */
interface AgentModelFields {
  readonly model: string | null;
  readonly modelConnectionName: string | null;
}

/** The Anthropic id in the launcher's `LOCAL_DEPLOYMENT_DEFAULT_MODELS_JSON` (S1-23). */
const LOCAL_ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-5';

/**
 * An agent as `aw push` writes it: no runtime profile named, and by default an explicit model and no
 * connection. `model: null` with `modelConnectionName: 'default'` is what `@indx-workspace/sdk`'s
 * version body writes for `model: 'default'` (S1-23).
 */
function agentFromVersion(
  name = 'Local runner',
  modelFields: AgentModelFields = { model: 'claude-sonnet-4-5', modelConnectionName: null },
  surfaceNames: readonly string[] = [],
): CreateAgentFromVersionRequestInput {
  return {
    version: {
      summary: 'First version',
      via: 'api',
      body: {
        definition: {
          apiVersion: 'agentworkspace.dev/v1',
          kind: 'AgentDefinition',
          agent: {
            name,
            instructions: 'Answer in one sentence.',
            permissions: {
              readFiles: true,
              writeFiles: false,
              runCommands: false,
              unrestrictedNetwork: false,
            },
            model: modelFields.model,
            modelConnectionName: modelFields.modelConnectionName,
            runtimeProfileName: null,
          },
          policy: {
            engine: 'claude-agent-sdk',
            tools: {
              base: 'claude_code_preset',
              autoApprove: [],
              deny: [],
              permissionMode: 'default',
              allowDangerouslySkipPermissions: false,
            },
            skills: { mode: 'all' },
            limits: { maxTurns: null, maxBudgetUsd: null },
          },
          policySource: 'stored',
          resources: { files: [], skills: [], connectors: [] },
        },
        surfaces: surfaceNames.map((surface) => ({ name: surface, agent: name })),
      },
    },
  };
}

/**
 * Poll `GET /api/runs/:id` until the run is terminal or has been `running` for
 * {@link LAUNCHED_AFTER_RUNNING_MS}, or fail after {@link RUN_TIMEOUT_MS}.
 */
async function settledRun(url: string, token: string, runId: string): Promise<RunResource> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let runningSince: number | null = null;
  for (;;) {
    const response = await fetch(new URL(`/api/runs/${runId}`, url), authorised(token));
    expect(response.status).toBe(200);
    const { run } = RunResponseSchema.parse(await response.json());
    if (isTerminalRunStatus(run.status)) return run;
    if (run.status === 'running') {
      runningSince ??= Date.now();
      if (Date.now() - runningSince >= LAUNCHED_AFTER_RUNNING_MS) return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} was still ${run.status} after ${String(RUN_TIMEOUT_MS)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The widget's session bootstrap, from a page of the runtime's own origin (S1-24). */
function openSurfaceSession(url: string, surface: string): Promise<Response> {
  return fetch(new URL(`/p/s/${surface}/sessions`, url), {
    method: 'POST',
    headers: { origin: url },
  });
}

/** The bootstrap admin's membership principal, read from the embedded database. */
async function bootstrapAdminPrincipalId(workspaceId: string): Promise<string> {
  const database = await openDatabaseRoot({ DATABASE_URL: EMBEDDED_DATABASE_URL });
  try {
    const members = await database.directory.forWorkspace(workspaceId).listMemberships();
    const admin = members.find((member) => member.email === BOOTSTRAP_ADMIN);
    if (admin === undefined) throw new Error('the bootstrap admin has no membership');
    return admin.principalId;
  } finally {
    await database.close();
  }
}

async function getAgentOwner(url: string, token: string, agentId: string): Promise<string> {
  const response = await fetch(new URL(`/api/agents/${agentId}`, url), authorised(token));
  expect(response.status).toBe(200);
  return AgentResourceSchema.parse(await response.json()).ownerPrincipalId;
}

function startMessage(projectDir: string, ports: Ports): LocalRuntimeStartMessage {
  return {
    type: 'start',
    projectDir,
    environment: { port: ports.web, runtimeDriver: 'local', bootstrapAdmin: BOOTSTRAP_ADMIN },
  };
}

describe('dist/bin.js forked with an IPC channel', () => {
  let projectDir = '';
  let ports: Ports = { web: 0, gateway: 0, runner: 0 };
  const runtimes: ForkedRuntime[] = [];
  let firstToken = '';
  let firstUrl = '';
  let firstWorkspaceId = '';
  let localProfileId = '';
  let agentId = '';
  /** Pushed with `model: 'default'` before the workspace had a `default` connection (#506 review). */
  let earlyAgentId = '';
  /** S1-24: the agent serving surface `main`, and the bootstrap admin's membership principal. */
  let surfaceAgentId = '';
  let adminPrincipalId = '';
  let firstExitedAt: Date | undefined;
  let firstSecrets: Buffer | null = null;
  let password = '';

  const runtimeDirectory = () => path.join(projectDir, '.agent-workspace');
  const secretsFile = () => path.join(runtimeDirectory(), 'secrets', 'local-secrets.json');

  beforeAll(async () => {
    if (!existsSync(bin)) {
      throw new Error(`run pnpm --filter @indx-workspace/embedded build first; missing: ${bin}`);
    }
    projectDir = mkdtempSync(path.join(tmpdir(), 'embedded-launcher-'));
    ports = await freePorts();
  });

  afterAll(async () => {
    await Promise.all(runtimes.map(async (runtime) => runtime.dispose()));
    if (projectDir !== '') {
      rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  }, STOP_TIMEOUT_MS);

  it(
    'answers start with ready, then a workspace API key that /api/me and /api/model-connections accept',
    async () => {
      const runtime = new ForkedRuntime(projectDir, ports);
      runtimes.push(runtime);
      await runtime.send(startMessage(projectDir, ports));
      const { ready, credential } = await runtime.started();
      await runtime.signInPrinted();

      expect(ready.url).toBe(`http://127.0.0.1:${String(ports.web)}`);
      expect(ready.contractsVersion).toBe(CONTRACTS_VERSION);
      expect(credential.workspaceSlug).toBe('default');
      expect(Date.parse(credential.expiresAt)).toBeGreaterThan(Date.now());
      expect(credential.token).toMatch(API_KEY_PATTERN);
      firstToken = credential.token;
      firstUrl = ready.url;
      firstWorkspaceId = credential.workspaceId;

      const response = await getMe(ready.url, credential.token);
      expect(response.status).toBe(200);
      const me = MeResponseSchema.parse(await response.json());
      expect(me).toMatchObject({ kind: 'api-key', workspaceId: credential.workspaceId });
      expect((await getModelConnections(ready.url, credential.token)).status).toBe(200);
      // An admin key, but not one that can mint a key to outlive the run (S1-21).
      const child = await fetch(new URL('/api/api-keys', ready.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'persisted', role: 'admin' }),
      });
      expect(child.status).toBe(403);
    },
    START_TIMEOUT_MS + 30_000,
  );

  it('makes a local runtime profile on the local driver the workspace default (S1-22)', async () => {
    expect(firstToken).not.toBe('');
    const profiles = await listRuntimeProfiles(firstUrl, firstToken);
    const local = profiles.filter((profile) => profile.name === 'local');
    expect(local).toHaveLength(1);
    expect(local[0]).toMatchObject({
      driver: 'local',
      networkPolicy: 'open',
      filesystem: 'read-write',
    });
    localProfileId = local[0]?.id ?? '';
    expect(localProfileId).not.toBe('');
  });

  it('stores a model: default agent pushed before any default connection with no connection (C7)', async () => {
    expect(localProfileId).not.toBe('');
    const created = await fetch(
      new URL('/api/agents', firstUrl),
      authorised(firstToken, {
        method: 'POST',
        body: JSON.stringify(
          agentFromVersion('Early default model', { model: null, modelConnectionName: 'default' }),
        ),
      }),
    );
    const createdBody: unknown = await created.json();
    expect(created.status, JSON.stringify(createdBody)).toBe(201);
    const { agent } = CreateAgentFromVersionResponseSchema.parse(createdBody);
    // What `aw dev` without ANTHROPIC_API_KEY leaves behind: a restart that creates `default`
    // does not re-apply this unchanged version.
    expect(agent.modelConnectionId).toBeNull();
    expect(agent.model).toBeNull();
    earlyAgentId = agent.id;
  });

  it(
    'runs an agent whose version names no runtime profile on the local default: 202, past runtime resolution',
    async () => {
      expect(localProfileId).not.toBe('');
      // As `aw dev` does: the `default` connection, here on a model host nothing listens on.
      const connection = await fetch(
        new URL('/api/model-connections', firstUrl),
        authorised(firstToken, {
          method: 'POST',
          body: JSON.stringify({
            name: 'default',
            provider: 'anthropic',
            apiKey: 'sk-ant-local-launcher-integration',
            config: { baseUrl: UNREACHABLE_MODEL_BASE_URL },
          }),
        }),
      );
      expect(connection.status).toBe(201);

      const created = await fetch(
        new URL('/api/agents', firstUrl),
        authorised(firstToken, { method: 'POST', body: JSON.stringify(agentFromVersion()) }),
      );
      expect(created.status).toBe(201);
      const { agent, version } = CreateAgentFromVersionResponseSchema.parse(await created.json());
      expect(version.body.definition.agent.runtimeProfileName).toBeNull();
      expect(agent.runtimeProfileId).toBe(localProfileId);
      agentId = agent.id;

      const ended = await runPastResolution(firstUrl, firstToken, agent.id);
      const [first] = runtimes;
      const logs = `${first?.stdout ?? ''}${first?.stderr ?? ''}`;
      for (const refusal of RUNTIME_RESOLUTION_FAILURES) {
        expect(ended.error ?? '', `the run's error names ${refusal}`).not.toContain(refusal);
        expect(logs, `the runtime's output names ${refusal}`).not.toContain(refusal);
      }
    },
    RUN_TIMEOUT_MS + 30_000,
  );

  it(
    'runs an agent that names the default connection but no model on the deployment default model (S1-23)',
    async () => {
      expect(agentId).not.toBe('');
      // The `default` connection the previous test created, on a model host nothing listens on.
      const created = await fetch(
        new URL('/api/agents', firstUrl),
        authorised(firstToken, {
          method: 'POST',
          body: JSON.stringify(
            agentFromVersion('Default model', { model: null, modelConnectionName: 'default' }),
          ),
        }),
      );
      const createdBody: unknown = await created.json();
      expect(created.status, JSON.stringify(createdBody)).toBe(201);
      const { agent } = CreateAgentFromVersionResponseSchema.parse(createdBody);
      expect(agent.modelConnectionId).not.toBeNull();
      expect(agent.model).toBeNull();
      expect(agent.runtimeProfileId).toBe(localProfileId);

      const ended = await runPastResolution(firstUrl, firstToken, agent.id);
      expect(ended.model).toBe(LOCAL_ANTHROPIC_DEFAULT_MODEL);
      expect(ended.modelConnectionId).toBe(agent.modelConnectionId);
      for (const refusal of ['model_connection_unresolved', 'model_unavailable']) {
        expect(ended.error ?? '', `the run's error names ${refusal}`).not.toContain(refusal);
      }
    },
    RUN_TIMEOUT_MS + 30_000,
  );

  it(
    'runs the agent pushed before the default connection existed on that connection now (#506 review)',
    async () => {
      expect(earlyAgentId).not.toBe('');
      const connections = await fetch(
        new URL('/api/model-connections', firstUrl),
        authorised(firstToken),
      );
      expect(connections.status).toBe(200);
      const listed = ModelConnectionListResponseSchema.parse(await connections.json());
      const defaultConnection = listed.models.find((entry) => entry.name === 'default');
      expect(defaultConnection).toBeDefined();

      const ended = await runPastResolution(firstUrl, firstToken, earlyAgentId);
      expect(ended.model).toBe(LOCAL_ANTHROPIC_DEFAULT_MODEL);
      expect(ended.modelConnectionId).toBe(defaultConnection?.id);
      for (const refusal of ['model_connection_unresolved', 'model_unavailable']) {
        expect(ended.error ?? '', `the run's error names ${refusal}`).not.toContain(refusal);
      }
    },
    RUN_TIMEOUT_MS + 30_000,
  );

  it('pushes an agent with a surface main owned by the bootstrap admin, not the per-run key (S1-24)', async () => {
    expect(firstToken).not.toBe('');
    const created = await fetch(
      new URL('/api/agents', firstUrl),
      authorised(firstToken, {
        method: 'POST',
        body: JSON.stringify(agentFromVersion('Front desk', undefined, ['main'])),
      }),
    );
    const createdBody: unknown = await created.json();
    expect(created.status, JSON.stringify(createdBody)).toBe(201);
    const { agent } = CreateAgentFromVersionResponseSchema.parse(createdBody);
    surfaceAgentId = agent.id;
    adminPrincipalId = await bootstrapAdminPrincipalId(firstWorkspaceId);
    expect(agent.ownerPrincipalId).toBe(adminPrincipalId);

    const opened = await openSurfaceSession(firstUrl, 'main');
    const openedBody: unknown = await opened.json();
    expect(opened.status, JSON.stringify(openedBody)).toBe(201);
    expect(SurfaceSessionResponseSchema.parse(openedBody).agentId).toBe(surfaceAgentId);
  });

  it('refuses the run with 422 once the default is deleted, leaving the agent with no profile', async () => {
    expect(agentId).not.toBe('');
    const deleted = await fetch(
      new URL(`/api/runtime-profiles/${localProfileId}`, firstUrl),
      authorised(firstToken, { method: 'DELETE' }),
    );
    expect(deleted.status).toBe(204);
    expect(await getAgentProfileId(firstUrl, firstToken, agentId)).toBeNull();
    const refused = await startRun(firstUrl, firstToken, agentId);
    const refusedBody = JSON.stringify(await refused.json());
    expect(refused.status, refusedBody).toBe(422);
    expect(refusedBody).toContain('agent_runtime_profile_missing');
  });

  it('writes .agent-workspace/.gitignore and an owner-only local-secrets.json', () => {
    expect(readFileSync(path.join(runtimeDirectory(), '.gitignore'), 'utf8')).toBe('*\n');
    expect(existsSync(secretsFile())).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(secretsFile()).mode & 0o777).toBe(0o600);
    }
    firstSecrets = readFileSync(secretsFile());
    password = LocalSecretsFileSchema.parse(
      JSON.parse(firstSecrets.toString('utf8')),
    ).BOOTSTRAP_ADMIN_PASSWORD;
  });

  it('prints where the generated password is kept, never the password (BH061-011)', () => {
    const [first] = runtimes;
    expect(password).not.toBe('');
    expect(first?.stdout).toContain('local-secrets.json');
    expect(first?.stdout).not.toContain(password);
  });

  it('leaves an agent owned by the first key itself, as a project pushed before S1-24 does', async () => {
    expect(earlyAgentId).not.toBe('');
    const database = await openDatabaseRoot({ DATABASE_URL: EMBEDDED_DATABASE_URL });
    const live = await database.directory
      .forWorkspace(firstWorkspaceId)
      .listApiKeys()
      .then((keys) =>
        keys.filter((key) => key.name.startsWith(LOCAL_KEY_NAME_PREFIX) && key.revokedAt === null),
      )
      .finally(() => database.close());
    expect(live).toHaveLength(1);
    const firstKeyPrincipalId = live[0]?.principalId ?? '';
    expect(firstKeyPrincipalId).not.toBe('');
    // Raw SQL, so `updated_at` stays what `aw push` and the default-profile attach compare.
    const { pool } = connect(readDatabaseConfig({ DATABASE_URL: EMBEDDED_DATABASE_URL }));
    try {
      const updated = await pool.query(
        'update agents set owner_principal_id = $1 where workspace_id = $2 and id = $3',
        [firstKeyPrincipalId, firstWorkspaceId, earlyAgentId],
      );
      expect(updated.rowCount).toBe(1);
    } finally {
      await pool.end();
    }
    expect(await getAgentOwner(firstUrl, firstToken, earlyAgentId)).toBe(firstKeyPrincipalId);
  });

  it(
    'exits 0 on SIGINT (on Windows, on the IPC channel closing)',
    async () => {
      const [first] = runtimes;
      expect(first).toBeDefined();
      // Only what the stop printed. Earlier tests ran agents whose model call cannot succeed, and a
      // run still in flight at the stop logs its own failure with a stack, so only the markers of
      // an unordered stop are checked here; the process-group test below checks for any stack.
      const before = first?.stderr.length ?? 0;
      const exit = await first?.interrupt();
      firstExitedAt = new Date();
      expect(exit).toStrictEqual({ code: 0, signal: null });
      expectNoUncleanStopOutput(first?.stderr.slice(before) ?? '');
    },
    STOP_TIMEOUT_MS + 10_000,
  );

  it(
    'restarts on the same secrets, prints only their path, and refuses the revoked key',
    async () => {
      expect(firstToken).not.toBe('');
      const runtime = new ForkedRuntime(projectDir, ports);
      runtimes.push(runtime);
      await runtime.send(startMessage(projectDir, ports));
      const { ready, credential } = await runtime.started();
      await runtime.signInPrinted();

      expect(readFileSync(secretsFile())).toStrictEqual(firstSecrets);
      expect(runtime.stdout).toContain('local-secrets.json');
      expect(runtime.stdout).not.toContain(password);
      expect(credential.token).not.toBe(firstToken);

      expect(credential.token).toMatch(API_KEY_PATTERN);
      expect((await getMe(ready.url, firstToken)).status).toBe(401);
      expect((await getModelConnections(ready.url, firstToken)).status).toBe(401);
      expect((await getMe(ready.url, credential.token)).status).toBe(200);
      expect((await getModelConnections(ready.url, credential.token)).status).toBe(200);

      // S1-22: the second start made a new `local` default for the deleted one, kept exactly one
      // `local` profile, and attached it to the agent that lost its profile: its run is accepted
      // again with no new push and no pointer move.
      const profiles = await listRuntimeProfiles(ready.url, credential.token);
      const local = profiles.filter((profile) => profile.name === 'local');
      expect(local).toStrictEqual([expect.objectContaining({ driver: 'local' })]);
      const newDefaultId = local[0]?.id ?? '';
      expect(newDefaultId).not.toBe(localProfileId);
      expect(await getAgentProfileId(ready.url, credential.token, agentId)).toBe(newDefaultId);
      const ended = await runPastResolution(ready.url, credential.token, agentId);
      for (const refusal of RUNTIME_RESOLUTION_FAILURES) {
        expect(ended.error ?? '', `the run's error names ${refusal}`).not.toContain(refusal);
      }

      // The stop revoked the first key, not this start's sweep of keys a crashed run left behind.
      const database = await openDatabaseRoot({ DATABASE_URL: EMBEDDED_DATABASE_URL });
      try {
        const keys = await database.directory.forWorkspace(firstWorkspaceId).listApiKeys();
        const local = keys.filter((key) => key.name.startsWith(LOCAL_KEY_NAME_PREFIX));
        expect(local).toHaveLength(2);
        const revoked = local.filter((key) => key.revokedAt !== null);
        expect(revoked).toHaveLength(1);
        const [first] = revoked;
        expect(firstExitedAt).toBeInstanceOf(Date);
        expect(first?.revokedAt?.getTime()).toBeLessThanOrEqual(firstExitedAt?.getTime() ?? 0);
      } finally {
        await database.close();
      }

      // S1-24: the first key is revoked, yet the widget still opens a session of the agent it
      // pushed, which the bootstrap admin owns; the repair at start moved the agent the first key
      // itself owned (data from before the fix) to the bootstrap admin too.
      expect(surfaceAgentId).not.toBe('');
      const opened = await openSurfaceSession(ready.url, 'main');
      const openedBody: unknown = await opened.json();
      expect(opened.status, JSON.stringify(openedBody)).toBe(201);
      expect(SurfaceSessionResponseSchema.parse(openedBody).agentId).toBe(surfaceAgentId);
      expect(await bootstrapAdminPrincipalId(firstWorkspaceId)).toBe(adminPrincipalId);
      expect(await getAgentOwner(ready.url, credential.token, surfaceAgentId)).toBe(
        adminPrincipalId,
      );
      expect(await getAgentOwner(ready.url, credential.token, earlyAgentId)).toBe(adminPrincipalId);

      expect(await runtime.interrupt()).toStrictEqual({ code: 0, signal: null });
    },
    START_TIMEOUT_MS + STOP_TIMEOUT_MS + RUN_TIMEOUT_MS + 30_000,
  );

  it('never prints a key on stdout or stderr', () => {
    const tokens = runtimes.flatMap((runtime) =>
      runtime.messages.flatMap((message) => (message.type === 'credential' ? [message.token] : [])),
    );
    expect(tokens).toHaveLength(2);
    for (const runtime of runtimes) {
      expect(runtime.stdout).not.toContain('ak_live_');
      expect(runtime.stderr).not.toContain('ak_live_');
      for (const token of tokens) {
        expect(runtime.stdout.includes(token)).toBe(false);
        expect(runtime.stderr.includes(token)).toBe(false);
      }
    }
  });
});

/**
 * S1-25 (#510): a terminal's Ctrl+C reaches only the launcher. The launcher is forked `detached`,
 * so it leads its own process group like a terminal job, and SIGINT goes to that whole group.
 */
describe('dist/bin.js leading its own process group, as a terminal job does', () => {
  let projectDir = '';
  const runtimes: ForkedRuntime[] = [];
  let postmasterPid: number | undefined;

  beforeAll(() => {
    if (!existsSync(bin)) {
      throw new Error(`run pnpm --filter @indx-workspace/embedded build first; missing: ${bin}`);
    }
    projectDir = mkdtempSync(path.join(tmpdir(), 'embedded-launcher-group-'));
  });

  afterAll(async () => {
    await Promise.all(runtimes.map(async (runtime) => runtime.dispose()));
    const pid = postmasterPid;
    if (pid !== undefined && process.platform !== 'win32' && isAlive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
    if (projectDir !== '') {
      rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  }, STOP_TIMEOUT_MS);

  it(
    'stops in order on a SIGINT to its whole group, and on a SIGHUP to it on the next start',
    async () => {
      const ports = await freePorts();
      const runtime = new ForkedRuntime(projectDir, ports, { detached: true });
      runtimes.push(runtime);
      await runtime.send(startMessage(projectDir, ports));
      const { credential } = await runtime.started();
      await runtime.signInPrinted();
      const pid = readPostmasterPid(projectDir);
      postmasterPid = pid;

      if (process.platform !== 'win32') {
        // The launcher leads its group; the postmaster must be in a group of its own.
        expect(processGroupOf(runtime.pid)).toBe(runtime.pid);
        expect(processGroupOf(pid)).not.toBe(runtime.pid);
      }

      const exit = await runtime.interruptGroup();
      const exitedAt = new Date();
      expect(exit, runtime.stderr).toStrictEqual({ code: 0, signal: null });
      expectCleanStop(runtime.stderr);
      if (process.platform !== 'win32') expect(isAlive(pid)).toBe(false);
      const held = await holdPort(EMBEDDED_DATABASE_PORT);
      expect(held, `port ${String(EMBEDDED_DATABASE_PORT)} is still in use`).not.toBeNull();
      if (held !== null) await new Promise<void>((resolve) => held.close(() => resolve()));

      // A normal restart on the same project: the first key was revoked by the stop.
      const nextPorts = await freePorts();
      const next = new ForkedRuntime(projectDir, nextPorts, { detached: true });
      runtimes.push(next);
      await next.send(startMessage(projectDir, nextPorts));
      const restarted = await next.started();
      await next.signInPrinted();
      const nextPid = readPostmasterPid(projectDir);
      postmasterPid = nextPid;
      expect((await getMe(restarted.ready.url, credential.token)).status).toBe(401);

      const database = await openDatabaseRoot({ DATABASE_URL: EMBEDDED_DATABASE_URL });
      try {
        const keys = await database.directory.forWorkspace(credential.workspaceId).listApiKeys();
        const revoked = keys.filter(
          (key) => key.name.startsWith(LOCAL_KEY_NAME_PREFIX) && key.revokedAt !== null,
        );
        expect(revoked).toHaveLength(1);
        expect(revoked[0]?.revokedAt?.getTime()).toBeLessThanOrEqual(exitedAt.getTime());
      } finally {
        await database.close();
      }

      // A closed terminal on a second start, which imports no embedded-postgres and so has no
      // library exit hook: SIGHUP's default action skips the `exit` backstop, so only the
      // launcher's own ordered stop ends the detached postmaster (review of #510).
      expect(await next.interruptGroup('SIGHUP'), next.stderr).toStrictEqual({
        code: 0,
        signal: null,
      });
      expectCleanStop(next.stderr);
      if (process.platform !== 'win32') expect(isAlive(nextPid)).toBe(false);
      const heldAfterHangUp = await holdPort(EMBEDDED_DATABASE_PORT);
      expect(
        heldAfterHangUp,
        `port ${String(EMBEDDED_DATABASE_PORT)} is still in use`,
      ).not.toBeNull();
      if (heldAfterHangUp !== null) {
        await new Promise<void>((resolve) => heldAfterHangUp.close(() => resolve()));
      }
    },
    2 * START_TIMEOUT_MS + 2 * STOP_TIMEOUT_MS + 30_000,
  );
});

/**
 * A taken embedded PostgreSQL port used to hang the runtime for good: the postmaster exited, and
 * `embedded-postgres` then waited for an exit event that never came again, so neither `failed` nor
 * `ready` was ever sent. It must now answer `failed` naming the port, and exit 1, promptly.
 */
describe('dist/bin.js with the embedded PostgreSQL port taken', () => {
  let projectDir = '';
  let holder: Server | null = null;
  let runtime: ForkedRuntime | null = null;

  beforeAll(async () => {
    if (!existsSync(bin)) {
      throw new Error(`run pnpm --filter @indx-workspace/embedded build first; missing: ${bin}`);
    }
    projectDir = mkdtempSync(path.join(tmpdir(), 'embedded-launcher-port-'));
    holder = await holdPort(EMBEDDED_DATABASE_PORT);
  });

  /** A stale holder (a postmaster an earlier failed run left) would turn this into a real start. */
  function expectPortHeld(): void {
    expect(
      holder,
      `port ${String(EMBEDDED_DATABASE_PORT)} was already taken before this suite could hold it`,
    ).not.toBeNull();
  }

  afterAll(async () => {
    await runtime?.dispose();
    const held = holder;
    if (held !== null) await new Promise<void>((resolve) => held.close(() => resolve()));
    if (projectDir !== '') {
      rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  }, STOP_TIMEOUT_MS);

  it(
    'answers start with failed naming the port, and exits 1',
    async () => {
      expectPortHeld();
      const ports = await freePorts();
      runtime = new ForkedRuntime(projectDir, ports);
      await runtime.send(startMessage(projectDir, ports));
      const exit = await runtime.ended(PORT_TAKEN_TIMEOUT_MS);

      expect(runtime.messages).toStrictEqual([
        {
          type: 'failed',
          message:
            'the local runtime cannot start; nothing was started. These ports are not free:\n' +
            `  port ${String(EMBEDDED_DATABASE_PORT)} (embedded PostgreSQL) is already in use: ` +
            'stop the process that holds it, or set AW_DATABASE_PORT in .env to a free port below 49152',
        },
      ]);
      expect(exit).toStrictEqual({ code: 1, signal: null });
    },
    PORT_TAKEN_TIMEOUT_MS + 10_000,
  );
});
