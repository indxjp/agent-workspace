/**
 * Issue #1506: `aw dev` runs a generated app. When `aw-generated.json` has an `app:<name>` entry,
 * after the runtime is ready `aw dev` migrates the app's schema `app_<name>` (the app kit's
 * `aw-app migrate`, spawned from the project's own install: `aw` never imports the app kit), starts
 * its Next.js dev server on the loopback address, and registers its MCP endpoint as the connector
 * `<name>` with `identity: { secret: APP_<NAME>_IDENTITY }` (ADR-0142) through the project plan, so
 * an agent's call to the app is signed as the person who asked.
 *
 * The identity key is 32 random bytes, kept in `.aw/app-identity.json` (`0600`; `.aw/` is
 * gitignored) and stored once as the workspace secret the connector names where the runtime's key
 * may write secrets; where it may not (an Admin's, spec §21), a notice names the secret an Owner
 * adds. It reaches only that secret's create or replace body and the app's environment: it is
 * never printed, logged or put on a command line.
 *
 * Issue #2075 (ADR-0161's 2026-11-01 amendment, DI5 and DI11): the app is also a client of `aw dev`'s
 * development OIDC issuer, at `<app origin>/api/sign-in/callback`, and gets the pair of its
 * `app-backend` endpoint client. Five names carry them: `AW_OIDC_ISSUER_URL`, `AW_OIDC_CLIENT_ID`,
 * `AW_OIDC_CLIENT_SECRET`, `AW_APP_CLIENT_ID` and `AW_APP_CLIENT_SECRET`. The two secrets reach only
 * the app's environment.
 *
 * shortcut: the app uses the embedded superuser locally, not its own role; upgrade when `aw deploy`
 * grows apps (U3.7).
 * shortcut: local dev uses the runtime's workspace key for role lookups (`AW_APP_API_KEY`), where
 * production uses an Admin key the operator provides; upgrade with the same unit.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { ConnectorResource } from '@indx-workspace/contracts/connectors';
import type { ProjectDocument, ProjectRead } from '@indx-workspace/contracts/project-file';
import { ApiProblemError, type AgentWorkspaceClient } from '@indx-workspace/sdk';
import { z } from 'zod';

import { writeOwnerOnlyJsonFile } from '../credentials.js';
import type { AppBackendCredentials } from './app-backend.js';
import { appKitEnvironment, resolveAppKit, runAppKit } from '../generate/app-kit.js';
import { entryNames, readManifest } from '../generate/manifest.js';
import { CommandRefusedError } from '../io.js';
import { isFree } from '../local-runtime/environment.js';
import { errorCode } from '../local-runtime/project.js';
import { findPackageDirectory } from '../local-runtime/resolve.js';
import { madeByAwDev } from '../project/tool-host.js';

/** The app's MCP route, which `mcpEndpoint` serves (`app/api/mcp/route.ts`). */
const APP_MCP_PATH = '/api/mcp';

/** The app's OIDC callback (U3.6-b), the redirect URI it registers at the issuer (DI5). */
const APP_SIGN_IN_CALLBACK_PATH = '/api/sign-in/callback';

/** Where the identity key is kept, relative to the project. */
export const APP_IDENTITY_FILE = path.join('.aw', 'app-identity.json');

/** Where the app's dev server writes, relative to the project; never the terminal. */
const APP_LOG_FILE = path.join('.aw', 'logs', 'app.log');

/** How far past the web port the app's port starts, and how many ports are tried from there. */
const APP_PORT_OFFSET = 100;
const APP_PORT_SEARCH_LIMIT = 50;

/** How long `next dev` may take to answer its MCP route: the first request compiles it. */
const APP_READY_TIMEOUT_MS = 180_000;
const APP_READY_POLL_MS = 500;

/** How long a stopped app has to exit before it is killed. */
const APP_STOP_GRACE_MS = 5_000;

/** The app `aw-generated.json` records, or `null` when the project has none. */
export interface DetectedApp {
  readonly name: string;
}

/**
 * The project's app: the first `app:<name>` entry of `aw-generated.json` (a project holds one), or
 * `null` when there is no manifest or no app in it. A manifest that is not one is refused, as
 * `aw generate` refuses it.
 */
export async function detectApp(cwd: string): Promise<DetectedApp | null> {
  const [name] = entryNames(await readManifest(cwd), 'app');
  return name === undefined ? null : { name };
}

/** `APP_<NAME>_IDENTITY`: the workspace secret the app's connector signs with. */
export function appIdentitySecretName(appName: string): string {
  return `APP_${appName.toUpperCase().replaceAll('-', '_')}_IDENTITY`;
}

const IdentityFileSchema = z.strictObject({
  version: z.literal(1),
  /** 32 random bytes, base64url. */
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  /** The workspace secret it was last stored as, so a second `aw dev` stores nothing. */
  stored: z
    .strictObject({ workspaceId: z.string().min(1), secretId: z.string().min(1) })
    .optional(),
});
type IdentityFile = z.infer<typeof IdentityFileSchema>;

async function readIdentityFile(cwd: string): Promise<IdentityFile | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(cwd, APP_IDENTITY_FILE), 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = IdentityFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new CommandRefusedError(
      `app_identity_unreadable: ${APP_IDENTITY_FILE} is not an identity file aw dev wrote`,
      `rm ${APP_IDENTITY_FILE}, then run aw dev again (a new key is made)`,
    );
  }
  return parsed.data;
}

/**
 * The app's identity key: read from `.aw/app-identity.json`, or made (32 random bytes, base64url)
 * and written there with mode `0600` on the first run. Never printed.
 */
export async function appIdentitySecret(cwd: string): Promise<string> {
  const existing = await readIdentityFile(cwd);
  if (existing !== undefined) return existing.secret;
  const secret = randomBytes(32).toString('base64url');
  await writeOwnerOnlyJsonFile(path.join(cwd, APP_IDENTITY_FILE), { version: 1, secret });
  return secret;
}

/** What {@link storeAppIdentitySecret} did. */
export type StoredIdentity = 'stored' | 'unchanged' | 'owner-only';

/**
 * Make the workspace hold the identity key as the secret {@link appIdentitySecretName} names, the
 * one the connector's `identity` references and the server resolves at run compose. Stored once:
 * a second `aw dev` against the same workspace finds the id it recorded and sends nothing
 * (`unchanged`). A secret of that name it did not record (a reset `.aw/`) is replaced, since only
 * the app's connector reads it.
 *
 * Secrets are an Owner's (spec §21), and the runtime's key is an Admin's: where the workspace
 * refuses it `403`, nothing is stored and the answer is `owner-only`, for the caller to say how an
 * Owner adds it. No role is widened for it.
 */
export async function storeAppIdentitySecret(
  client: AgentWorkspaceClient,
  options: {
    readonly cwd: string;
    readonly appName: string;
    readonly workspaceId: string;
    readonly signal: AbortSignal;
  },
): Promise<StoredIdentity> {
  const file = (await readIdentityFile(options.cwd)) ?? {
    version: 1 as const,
    secret: await appIdentitySecret(options.cwd),
  };
  const name = appIdentitySecretName(options.appName);
  let stored: { readonly id: string };
  try {
    const held = await listSecret(client, name, options.signal);
    if (
      held !== undefined &&
      file.stored?.workspaceId === options.workspaceId &&
      file.stored.secretId === held.id
    ) {
      return 'unchanged';
    }
    stored =
      held === undefined
        ? await client.secrets.create({ name, value: file.secret }, { signal: options.signal })
        : await client.secrets.replace(held.id, file.secret, { signal: options.signal });
  } catch (error) {
    if (error instanceof ApiProblemError && error.status === 403) return 'owner-only';
    throw error;
  }
  await writeOwnerOnlyJsonFile(path.join(options.cwd, APP_IDENTITY_FILE), {
    version: 1,
    secret: file.secret,
    stored: { workspaceId: options.workspaceId, secretId: stored.id },
  });
  return 'stored';
}

/**
 * The notice for `owner-only`: which secret an Owner adds and where its value is, never the value.
 */
export function ownerOnlyIdentityNotice(appName: string): string {
  const name = appIdentitySecretName(appName);
  return (
    `notice: the ${appName} connector signs each agent call with the workspace secret ${name}, ` +
    `which only an Owner may store (aw dev holds an Admin key). Sign in to the console as an Owner ` +
    `and add ${name} under Secrets with the "secret" value in ${APP_IDENTITY_FILE}; until then a ` +
    `run that reaches the ${appName} connector is refused.\n`
  );
}

async function listSecret(
  client: AgentWorkspaceClient,
  name: string,
  signal: AbortSignal,
): Promise<{ readonly id: string } | undefined> {
  try {
    return (await client.secrets.list({ name, signal })).find((secret) => secret.name === name);
  } catch (error) {
    if (error instanceof ApiProblemError && error.status === 404) return undefined;
    throw error;
  }
}

/** The connector `aw dev` registers for the app, as a project file would declare it. */
function appConnector(
  appName: string,
  url: string,
): NonNullable<ProjectDocument['connectors']>[string] {
  return { url, transport: 'http', identity: { secret: appIdentitySecretName(appName) } };
}

/**
 * Whether `connector` is the one `aw dev` registers for the app `appName`: a loopback `http`
 * connector with no credential (as the tool host's, `madeByAwDev`), at the app's MCP route, that
 * signs with the app's identity secret.
 */
function madeByAwDevApp(connector: ConnectorResource, appName: string): boolean {
  return (
    madeByAwDev(connector) &&
    connector.url !== null &&
    new URL(connector.url).pathname === APP_MCP_PATH &&
    connector.identity?.secret === appIdentitySecretName(appName)
  );
}

/**
 * The project file with the app's connector added in memory (`agent-workspace.yaml` is never
 * edited), and the id of the one `aw dev` registered before, if any. A connector of the app's name
 * that the project file declares, or that `aw dev` did not create, is refused as
 * `app_connector_conflict`: it is never re-pointed, so its stored auth never reaches the app.
 */
export function withAppConnector(
  read: ProjectRead,
  appName: string,
  url: string,
  existing: readonly ConnectorResource[],
): { readonly read: ProjectRead; readonly connectorId: string | undefined } {
  if (read.lifted) {
    throw new CommandRefusedError(
      'app_needs_project_file: an app runs from an agent-workspace.yaml project file, not a lifted v1 profile',
      'aw init --yes',
    );
  }
  if (read.project.connectors?.[appName] !== undefined) {
    throw new CommandRefusedError(
      `app_connector_conflict: agent-workspace.yaml declares a connector named ${appName}, which aw dev registers for the app`,
      `rename connectors.${appName} in agent-workspace.yaml`,
    );
  }
  const current = existing.find((connector) => connector.name === appName);
  if (current !== undefined && !madeByAwDevApp(current, appName)) {
    throw new CommandRefusedError(
      `app_connector_conflict: a connector named ${appName} that aw dev did not create already exists; aw dev will not re-point it`,
      `aw connectors delete ${current.id}, or rename that connector`,
    );
  }
  const connectors = { ...read.project.connectors, [appName]: appConnector(appName, url) };
  return {
    read: { ...read, project: { ...read.project, connectors } },
    connectorId: current?.id,
  };
}

/** What the app's process is started with; every value is `aw dev`'s own, never a file's. */
interface AppEnvironment {
  /** The runtime's URL (`AW_URL`). */
  readonly awUrl: string;
  /** The app's database (`DATABASE_URL`), the runtime's loopback PostgreSQL or `aw`'s own. */
  readonly databaseUrl: string;
  /** The local workspace (`AW_WORKSPACE_ID`). */
  readonly workspaceId: string;
  /** The runtime's workspace key (`AW_APP_API_KEY`), for the app's role lookups (see shortcut). */
  readonly apiKey: string;
  /** The identity key (`AW_APP_IDENTITY_SECRET`). */
  readonly identitySecret: string;
}

/** The app's client at `aw dev`'s development issuer (DI5, DI11's `AW_OIDC_*`). */
export interface AppOidcClient {
  readonly issuerUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** A child process as {@link startApp} uses it. */
export interface AppChild {
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
}

/** Everything {@link startApp} reaches outside itself, so a test drives it with fakes. */
export interface AppDeps {
  /** Runs `aw-app migrate`; the real one is the app kit's bin through {@link runAppKit}. */
  readonly migrate: (options: {
    readonly cwd: string;
    readonly appName: string;
    readonly databaseUrl: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly signal: AbortSignal;
  }) => Promise<{ readonly code: number | null; readonly stderr: string }>;
  /** The script `node` runs as the Next.js CLI, from the project's own install. */
  readonly nextBin: (cwd: string) => Promise<string>;
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: Record<string, string> },
  ) => AppChild;
  readonly isFree: (port: number) => Promise<boolean>;
  readonly fetch: typeof fetch;
  /** Where the dev server's output goes. */
  readonly log: (cwd: string) => Promise<NodeJS.WritableStream>;
}

/** The app's running dev server. */
export interface RunningApp {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** The connector URL: {@link origin} + {@link APP_MCP_PATH}. */
  readonly mcpUrl: string;
  /** The connector id the app runs with; `undefined` before the connector exists. */
  readonly connectorId: string | undefined;
  /**
   * Restart once with `connectorId`, and `appBackend` when given, when either differs from what
   * the app runs with.
   */
  restartWith(connectorId: string, appBackend?: AppBackendCredentials): Promise<boolean>;
  /** Stop the app and wait for it to exit. */
  stop(): Promise<void>;
}

/** What {@link startApp} takes. */
export interface StartAppOptions {
  readonly cwd: string;
  readonly appName: string;
  /** The runtime's web port; the app's is the first free one from it + 100. */
  readonly webPort: number;
  readonly environment: AppEnvironment;
  /** The connector id `aw dev` registered before, if any. */
  readonly connectorId: string | undefined;
  /**
   * Registers the app at the development issuer with its redirect URI once its port is known, and
   * answers its client; absent when `aw dev` runs no issuer (DI11).
   */
  readonly oidcClient?: ((redirectUri: string) => AppOidcClient) | undefined;
  /** The `app-backend` client's pair, when it was minted before the app starts (DI10). */
  readonly appBackend?: AppBackendCredentials | undefined;
  /** `aw dev`'s environment: only {@link appKitEnvironment}'s names of it reach the app. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Aborted when `aw dev` ends: the app is stopped. */
  readonly signal: AbortSignal;
}

async function freeAppPort(
  webPort: number,
  probe: (port: number) => Promise<boolean>,
): Promise<number> {
  for (let step = 0; step < APP_PORT_SEARCH_LIMIT; step += 1) {
    const port = webPort + APP_PORT_OFFSET + step;
    if (port <= 65_535 && (await probe(port))) return port;
  }
  throw new CommandRefusedError(
    `app_port_busy: no free port from ${String(webPort + APP_PORT_OFFSET)} to ${String(webPort + APP_PORT_OFFSET + APP_PORT_SEARCH_LIMIT - 1)} for the app`,
    'stop what holds those ports, or start aw dev on another --port',
  );
}

/** The app's environment: the allowlisted process variables, then `aw dev`'s own values. */
function appEnv(
  options: StartAppOptions,
  port: number,
  connectorId: string | undefined,
  signIn: {
    readonly oidc: AppOidcClient | undefined;
    readonly appBackend: AppBackendCredentials | undefined;
  },
): Record<string, string> {
  const { environment } = options;
  const { oidc, appBackend } = signIn;
  return {
    ...appKitEnvironment(options.env),
    NEXT_TELEMETRY_DISABLED: '1',
    PORT: String(port),
    AW_URL: environment.awUrl,
    AW_APP_NAME: options.appName,
    DATABASE_URL: environment.databaseUrl,
    AW_WORKSPACE_ID: environment.workspaceId,
    AW_APP_IDENTITY_SECRET: environment.identitySecret,
    AW_APP_API_KEY: environment.apiKey,
    ...(connectorId === undefined ? {} : { AW_APP_CONNECTOR_ID: connectorId }),
    ...(oidc === undefined
      ? {}
      : {
          AW_OIDC_ISSUER_URL: oidc.issuerUrl,
          AW_OIDC_CLIENT_ID: oidc.clientId,
          AW_OIDC_CLIENT_SECRET: oidc.clientSecret,
        }),
    ...(appBackend === undefined
      ? {}
      : { AW_APP_CLIENT_ID: appBackend.clientId, AW_APP_CLIENT_SECRET: appBackend.clientSecret }),
  };
}

function exited(child: AppChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Wait for `GET <mcpUrl>` to answer `405`, the MCP route compiled and serving. */
async function waitForApp(
  child: AppChild,
  mcpUrl: string,
  deps: AppDeps,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + APP_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (exited(child)) {
      throw new CommandRefusedError(
        `app_not_started: the app's dev server exited before it answered ${APP_MCP_PATH}; see ${APP_LOG_FILE}`,
        'npm install, then run aw dev again',
      );
    }
    try {
      const response = await deps.fetch(mcpUrl, { method: 'GET', signal });
      await response.body?.cancel();
      if (response.status === 405) return;
    } catch (error) {
      if (signal.aborted) throw error;
      // Not listening yet.
    }
    await delay(APP_READY_POLL_MS, undefined, { signal });
  }
  throw new CommandRefusedError(
    `app_not_started: the app did not answer ${APP_MCP_PATH} within ${String(APP_READY_TIMEOUT_MS / 1000)} s; see ${APP_LOG_FILE}`,
  );
}

async function stopChild(child: AppChild): Promise<void> {
  if (exited(child)) return;
  const done = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), APP_STOP_GRACE_MS);
  try {
    await done;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Migrate the app, then start its Next.js dev server on `127.0.0.1` and wait until its MCP route
 * answers. A migration that exits non-zero is refused with what it printed on stderr, and `next
 * dev` is never started. The server's output goes to {@link APP_LOG_FILE}; it is stopped when
 * `signal` aborts.
 */
export async function startApp(options: StartAppOptions, deps: AppDeps): Promise<RunningApp> {
  const { cwd, appName, signal } = options;
  const migrated = await deps.migrate({
    cwd,
    appName,
    databaseUrl: options.environment.databaseUrl,
    env: options.env,
    signal,
  });
  if (migrated.code !== 0) {
    const reason =
      migrated.stderr.trim().replace(/^error: /u, '') || `exit code ${String(migrated.code)}`;
    throw new CommandRefusedError(
      `app_migration_failed: aw-app migrate could not migrate the ${appName} app: ${reason}`,
      'fix the migration under db/migrations, then run aw dev again',
    );
  }
  const port = await freeAppPort(options.webPort, deps.isFree);
  const origin = `http://127.0.0.1:${String(port)}`;
  const mcpUrl = `${origin}${APP_MCP_PATH}`;
  const nextBin = await deps.nextBin(cwd);
  const log = await deps.log(cwd);
  let connectorId = options.connectorId;
  let appBackend = options.appBackend;
  const oidc = options.oidcClient?.(`${origin}${APP_SIGN_IN_CALLBACK_PATH}`);
  let child: AppChild | undefined;

  const launch = async (): Promise<void> => {
    const started = deps.spawn(
      process.execPath,
      [nextBin, 'dev', '-p', String(port), '-H', '127.0.0.1'],
      { cwd, env: appEnv(options, port, connectorId, { oidc, appBackend }) },
    );
    child = started;
    started.stdout?.pipe(log, { end: false });
    started.stderr?.pipe(log, { end: false });
    await waitForApp(started, mcpUrl, deps, signal);
  };
  const stop = async (): Promise<void> => {
    if (child !== undefined) await stopChild(child);
  };
  signal.addEventListener('abort', () => void stop(), { once: true });
  try {
    await launch();
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    origin,
    mcpUrl,
    get connectorId() {
      return connectorId;
    },
    async restartWith(id, backend) {
      const newBackend =
        backend !== undefined &&
        (backend.clientId !== appBackend?.clientId ||
          backend.clientSecret !== appBackend.clientSecret);
      if (id === connectorId && !newBackend) return false;
      connectorId = id;
      if (backend !== undefined) appBackend = backend;
      await stop();
      await launch();
      return true;
    },
    stop,
  };
}

/** The script of the project's Next.js CLI (`next`'s `bin.next`), run with `node`. */
async function projectNextBin(cwd: string): Promise<string> {
  const directory = await findPackageDirectory(cwd, 'next');
  const fix = 'npm install';
  if (directory === undefined) {
    throw new CommandRefusedError(
      'app_next_not_installed: next is not installed in this project',
      fix,
    );
  }
  let bin: unknown;
  try {
    bin = (
      JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as {
        bin?: unknown;
      }
    ).bin;
  } catch {
    bin = undefined;
  }
  const script =
    typeof bin === 'object' && bin !== null && 'next' in bin && typeof bin.next === 'string'
      ? bin.next
      : undefined;
  if (script === undefined) {
    throw new CommandRefusedError(
      'app_next_not_installed: next in node_modules has no next bin',
      fix,
    );
  }
  return path.resolve(directory, script);
}

/** The real {@link AppDeps}: the project's own `aw-app` and `next`, on this machine. */
function nodeAppDeps(): AppDeps {
  return {
    async migrate({ cwd, appName, databaseUrl, env, signal }) {
      const { binPath } = await resolveAppKit(cwd);
      return runAppKit(binPath, ['migrate', '--app', appName, '--dir', 'db/migrations'], {
        cwd,
        env,
        extraEnv: { DATABASE_URL: databaseUrl },
        signal,
      });
    },
    nextBin: projectNextBin,
    spawn: (command, args, options) =>
      spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    isFree,
    fetch: (input, init) => fetch(input, init),
    async log(cwd) {
      const file = path.join(cwd, APP_LOG_FILE);
      await mkdir(path.dirname(file), { recursive: true });
      return createWriteStream(file, { flags: 'a' });
    },
  };
}

/** What {@link startDevApp} takes: the session `aw dev` signed in with and where the app runs. */
export interface StartDevAppOptions {
  readonly client: AgentWorkspaceClient;
  readonly cwd: string;
  readonly appName: string;
  readonly read: ProjectRead;
  readonly session: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly workspaceId: string;
  };
  readonly webPort: number;
  /** `DATABASE_URL` in `aw dev`'s environment, else the runtime's `ready.databaseUrl`. */
  readonly databaseUrl: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where a notice goes: `aw dev`'s stderr. */
  readonly stderr: (text: string) => void;
  readonly signal: AbortSignal;
  /** See {@link StartAppOptions.oidcClient}. */
  readonly oidcClient?: ((redirectUri: string) => AppOidcClient) | undefined;
  /**
   * The `app-backend` pair to start the app with (DI10), asked for once the app's checks passed;
   * absent or `undefined` when there is none yet.
   */
  readonly appBackend?: (() => Promise<AppBackendCredentials | undefined>) | undefined;
}

/**
 * `aw dev`'s app step, after sign-in and before the project's resources are applied: refuse a
 * foreign connector of the app's name, store the identity key as its workspace secret, migrate and
 * start the app, and return the project file with the app's connector added, for the one plan.
 */
export async function startDevApp(
  options: StartDevAppOptions,
  deps: AppDeps = nodeAppDeps(),
): Promise<{ readonly read: ProjectRead; readonly app: RunningApp }> {
  const { client, cwd, appName, signal } = options;
  if (options.databaseUrl === undefined) {
    throw new CommandRefusedError(
      `app_database_unavailable: the local runtime named no loopback database for the ${appName} app`,
      'set DATABASE_URL in the environment of aw dev to the PostgreSQL the app should use',
    );
  }
  const existing = await client.connectors.list({ signal });
  // The URL is checked once the port is known; a placeholder settles the conflict first.
  withAppConnector(options.read, appName, `http://127.0.0.1${APP_MCP_PATH}`, existing);
  const registered = existing.find(
    (connector) => connector.name === appName && madeByAwDevApp(connector, appName),
  );
  const identity = await storeAppIdentitySecret(client, {
    cwd,
    appName,
    workspaceId: options.session.workspaceId,
    signal,
  });
  if (identity === 'owner-only') options.stderr(ownerOnlyIdentityNotice(appName));
  const app = await startApp(
    {
      cwd,
      appName,
      webPort: options.webPort,
      environment: {
        awUrl: options.session.baseUrl,
        databaseUrl: options.databaseUrl,
        workspaceId: options.session.workspaceId,
        apiKey: options.session.apiKey,
        identitySecret: await appIdentitySecret(cwd),
      },
      connectorId: registered?.id,
      oidcClient: options.oidcClient,
      appBackend: await options.appBackend?.(),
      env: options.env,
      signal,
    },
    deps,
  );
  return { read: withAppConnector(options.read, appName, app.mcpUrl, existing).read, app };
}

/**
 * After the plan was applied: read the app connector's id and restart the app once when it is not
 * the id the app runs with (the first `aw dev`, which created the connector), or when `appBackend`
 * is a pair the app does not run with yet (DI10: the first `aw dev`, which created that client).
 * Returns whether the app was restarted; a connector the plan could not create leaves the app as it
 * is.
 */
export async function settleAppConnector(
  client: AgentWorkspaceClient,
  app: RunningApp,
  appName: string,
  signal: AbortSignal,
  appBackend?: AppBackendCredentials,
): Promise<boolean> {
  const connector = (await client.connectors.list({ signal })).find(
    (entry) => entry.name === appName && madeByAwDevApp(entry, appName),
  );
  return connector === undefined ? false : app.restartWith(connector.id, appBackend);
}
