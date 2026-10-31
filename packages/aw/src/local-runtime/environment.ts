import { createServer } from 'node:net';
import { Writable, type Readable } from 'node:stream';
import { createInterface } from 'node:readline/promises';

import {
  BootstrapAdminSchema,
  DEFAULT_LOCAL_PORT,
  LOCAL_RUNTIME_GATEWAY_PORT,
  LOCAL_RUNTIME_RUNNER_PORT,
  type ImplementedRuntimeDriver,
  type ProjectRead,
} from '@indx-workspace/contracts/project-file';
import {
  LocalRuntimeStartMessageSchema,
  type LocalRuntimeStartMessage,
} from '@indx-workspace/contracts/local-runtime';

import { nonBlank } from '../config.js';
import { CommandRefusedError, InterruptedError } from '../io.js';
import { localPortOf, modelSecretNames } from './project.js';

/**
 * `env` without `names`, whatever their case (SD17): the environment every child `aw` forks gets.
 * A name is compared by its ASCII upper-case, as the runtime's own check compares it.
 */
export function withoutNames(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): Record<string, string> {
  const withheld = new Set(names.map((name) => name.toUpperCase()));
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !withheld.has(name.toUpperCase())) result[name] = value;
  }
  return result;
}

/**
 * The runtime drivers the local runtime can run on a developer's machine (ADR-0109). The other
 * implemented drivers — `kubernetes`, `cloud-run-service`, `aca-sessions` — need a cluster or a
 * cloud account that `aw dev` does not provision, so a project naming one is refused rather than
 * started and left to fail on its first run. `sandbox-runtime` stays listed so a project that
 * already names it keeps starting; it has no implementation, and `aw dev` runs it on `local` and
 * says so (#818).
 */
const LOCALLY_RUNNABLE_DRIVERS = [
  'local',
  'sandbox-runtime',
  'docker',
] as const satisfies readonly ImplementedRuntimeDriver[];

function isLocallyRunnable(driver: ImplementedRuntimeDriver): boolean {
  return LOCALLY_RUNNABLE_DRIVERS.some((candidate) => candidate === driver);
}

/** The project file's own spelling of a field of the local environment, for a refusal. */
function fieldPath(read: ProjectRead, field: string): string {
  return read.lifted ? field : `environments.local.${field}`;
}

/**
 * The `start` message for the project in `cwd`: the local environment's port, runtime driver and
 * bootstrap Owner, validated against the contract before anything is forked. An environment the
 * local runtime cannot honour is refused by its field path. The project file's `policy` (C13), its
 * `features` (ADR-0160 D5) and the `withheld` secret names (SD17) are sent only when there are any,
 * so a slice-1 project's `start` is unchanged.
 */
export function localStartMessage(
  read: ProjectRead,
  cwd: string,
  withheld: readonly string[] = [],
  /** A free web port `aw dev` chose because the unpinned one was busy (issue #692). */
  portOverride?: number,
): LocalRuntimeStartMessage {
  const local = read.project.environments.local;
  if (local === undefined) {
    throw new CommandRefusedError(
      'agent-workspace.yaml describes no local environment (cloud is not local), so aw dev has nothing to run',
      'set cloud: local, or run aw init --yes in a new directory',
    );
  }
  if (read.lifted && read.project.environments.local?.storage !== undefined) {
    throw new CommandRefusedError(
      `agent-workspace.yaml: ${fieldPath(read, 'storage')}: aw dev provides its own storage and cannot use a configured store`,
      `remove ${fieldPath(read, 'storage')} for local development`,
    );
  }
  const driver = local.runtime?.default;
  if (driver !== undefined && !isLocallyRunnable(driver)) {
    const field = fieldPath(read, 'runtime.default');
    throw new CommandRefusedError(
      `agent-workspace.yaml: ${field}: aw dev cannot run the ${driver} driver locally`,
      `set ${field} to one of ${LOCALLY_RUNNABLE_DRIVERS.join(', ')}`,
    );
  }
  const port = portOverride ?? (read.lifted ? DEFAULT_LOCAL_PORT : localPortOf(read));
  const parsed = LocalRuntimeStartMessageSchema.safeParse({
    type: 'start',
    projectDir: cwd,
    environment: {
      port,
      ...(driver === undefined ? {} : { runtimeDriver: driver }),
      bootstrapAdmin: local.identity.bootstrapAdmin,
      ...(read.lifted || read.project.policy === undefined ? {} : { policy: read.project.policy }),
      ...(read.lifted || read.project.features === undefined
        ? {}
        : { features: read.project.features }),
      ...(withheld.length === 0 ? {} : { withheld }),
      modelSecrets: modelSecretNames(read),
    },
  });
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.map(String).join('.'));
    throw new CommandRefusedError(
      `aw dev cannot start the local runtime for this project: ${paths.join(', ')}`,
    );
  }
  return parsed.data;
}

/** What `aw dev` takes from the environment for the `default` model connection (C6). */
export interface AnthropicSettings {
  /** `undefined` when `ANTHROPIC_API_KEY` is unset or blank. Never printed, never written. */
  readonly apiKey: string | undefined;
  readonly baseUrl: string | undefined;
}

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL`, checked before anything is forked. A base URL that
 * is not an absolute `http(s)` URL is refused by name; its value is not echoed, because a proxy URL
 * may carry a credential.
 */
export function anthropicSettings(
  env: Readonly<Record<string, string | undefined>>,
): AnthropicSettings {
  const baseUrl = nonBlank(env['ANTHROPIC_BASE_URL']);
  if (baseUrl !== undefined && !isHttpUrl(baseUrl)) {
    throw new CommandRefusedError(
      'ANTHROPIC_BASE_URL is not an absolute http(s) URL',
      'set ANTHROPIC_BASE_URL to a URL such as https://api.anthropic.com, or unset it',
    );
  }
  return { apiKey: nonBlank(env['ANTHROPIC_API_KEY']), baseUrl };
}

/**
 * The address the local runtime signs `aw` in as, exactly as the runtime derives it: its own
 * `BOOTSTRAP_ADMIN` override, else the project's bootstrap Owner, lowercased. The project's value
 * already passed `BootstrapAdminSchema` with the `start` message, which refuses a control character;
 * the override has not, so the final address is checked against the same schema before anything is
 * forked. `aw dev` prints it, so a refused address is never echoed.
 */
export function signedInIdentity(
  env: Readonly<Record<string, string | undefined>>,
  start: LocalRuntimeStartMessage,
): string {
  const identity = (env['BOOTSTRAP_ADMIN'] ?? start.environment.bootstrapAdmin).toLowerCase();
  if (!BootstrapAdminSchema.safeParse(identity).success) {
    throw new CommandRefusedError(
      'the bootstrap admin address is not a plain email address (it may hold a control character), so aw dev will not print or use it',
      'set identity.bootstrapAdmin in agent-workspace.yaml (or BOOTSTRAP_ADMIN) to a plain email address',
    );
  }
  return identity;
}

/** Whether `port` can be bound on the loopback address right now. */
function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/** The embedded PostgreSQL port the runtime binds when `DATABASE_URL` is not set. */
const LOCAL_DATABASE_PORT = 25_432;

/** How many steps past the default `aw dev` looks for a free set before it gives up. */
const FREE_PORT_SEARCH_LIMIT = 50;

/**
 * Issue #692: the web port to run on when the project does not pin one. The runtime moves its
 * service ports with the web port (#664), so the four move together: step 0 is the default set,
 * step 1 is 3001 / 4001 / 8081 / 25433, and so on. `null` when the project pins a port (a busy one
 * stays the runtime's refusal), when the default set is free, or when a service port is set in
 * `env` (it does not move with the web port). Otherwise `{ port, busy }`: the free web port and the
 * first port of the default set that was taken.
 * ponytail: a service port set only in `.env` is not probed here; the runtime still refuses it.
 */
export async function freeWebPort(
  read: ProjectRead,
  env: Readonly<Record<string, string | undefined>>,
  probe: (port: number) => Promise<boolean> = isFree,
): Promise<{ readonly port: number; readonly busy: number } | null> {
  if (!read.lifted && read.project.environments.local?.port !== undefined) return null;
  // A set value, even a blank one, is the runtime's to use as it is.
  if (
    ['GATEWAY_PORT', 'RUNNER_PORT', 'AW_DATABASE_PORT', 'PORT'].some(
      (name) => env[name] !== undefined,
    )
  ) {
    return null;
  }
  // With `DATABASE_URL` the runtime binds no PostgreSQL of its own.
  const bases = [
    DEFAULT_LOCAL_PORT,
    LOCAL_RUNTIME_GATEWAY_PORT,
    LOCAL_RUNTIME_RUNNER_PORT,
    ...(env['DATABASE_URL'] ? [] : [LOCAL_DATABASE_PORT]),
  ];
  let busy: number | undefined;
  for (let step = 0; step <= FREE_PORT_SEARCH_LIMIT; step += 1) {
    const taken = (
      await Promise.all(bases.map(async (base) => ((await probe(base + step)) ? 0 : base + step)))
    ).find((port) => port !== 0);
    if (taken === undefined)
      return step === 0
        ? null
        : { port: DEFAULT_LOCAL_PORT + step, busy: busy ?? DEFAULT_LOCAL_PORT };
    busy ??= taken;
  }
  return null;
}

/** Where the line that sets a variable is written: POSIX shells, or Windows (PowerShell and cmd). */
export type KeyShell = 'posix' | 'windows';

/**
 * Windows prints both lines because the shell cannot be told: `npm run dev` runs `aw` under
 * cmd.exe whatever shell the person typed it in, and `PSModulePath` is set system-wide.
 */
export function keyShell(platform: NodeJS.Platform = process.platform): KeyShell {
  return platform === 'win32' ? 'windows' : 'posix';
}

/**
 * Issue #690: the lines under a missing model key, shared by the ready screen and the prompt: what
 * is missing, then the line that sets it (on Windows one for PowerShell and one for cmd). Only the
 * variable's name is ever in them.
 */
export function missingKeyLines(name: string, shell: KeyShell = keyShell()): readonly string[] {
  const value = name === 'ANTHROPIC_API_KEY' ? 'sk-ant-…' : '<your key>';
  const problem = `no ${name} in this shell`;
  if (shell === 'posix') return [problem, `export ${name}=${value}`];
  return [problem, `PowerShell: $env:${name}="${value}"`, `cmd:        set ${name}=${value}`];
}

/**
 * Read one line from `input` without echoing it: the question is written to `output`, what is
 * typed is not. The key a person pastes is only ever returned, never written anywhere. Ctrl-C,
 * Ctrl-D or `signal` ends it as an {@link InterruptedError}.
 */
export async function promptSecret(
  question: string,
  input: Readable,
  output: Writable,
  signal?: AbortSignal,
): Promise<string> {
  let muted = false;
  const sink = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  const terminal = createInterface({ input, output: sink, terminal: true, historySize: 0 });
  try {
    const answer = terminal.question(question, signal === undefined ? {} : { signal });
    muted = true;
    return await answer;
  } catch (error) {
    // Ctrl-C and Ctrl-D are keypresses in raw mode, and `signal` is SIGINT/SIGTERM: all are an interrupt.
    if (error instanceof Error && error.name === 'AbortError') throw new InterruptedError();
    throw error;
  } finally {
    terminal.close();
    muted = false;
    output.write('\n');
  }
}
