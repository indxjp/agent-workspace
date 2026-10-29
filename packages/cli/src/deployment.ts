import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

import { COMPOSE_PROJECT_NAME_PATTERN, RESERVED_COMPOSE_PROJECT_NAME } from './compose-project.ts';
import { COMPOSE_PROJECT_CREATE_COMMAND, type DeploymentCloud } from './profile.ts';
import {
  PLATFORM_IMAGE_VERSION,
  PLATFORM_IMAGES_WORKFLOW,
  platformImageTag,
} from './release-images.ts';

const digestPattern = /@sha256:[0-9a-f]{64}$/u;

export interface DeploymentImages {
  readonly web: string;
  readonly gateway: string;
  readonly runner: string;
  /**
   * The `claude-agent-sdk` engine's runtime image (ENG-07, ADR-0073), rendered as that engine's
   * entry of the `engine → image` map. Only that engine has an adapter today; a later engine unit
   * widens this to one field per engine.
   */
  readonly runtime: string;
  /**
   * The two services only the Compose project runs. A cloud deployment takes its database and its
   * bucket from the cloud, so a reference set rendered for one carries neither.
   */
  readonly postgres?: string;
  /** The Compose project's S3-compatible object store (ADR-0067). */
  readonly seaweedfs?: string;
}

/**
 * The platform references come from `release-images.json`, the one list the image release
 * workflow publishes (#370, ADR-0086); the two Compose-only services are third-party images.
 */
const releaseTags: Required<DeploymentImages> = {
  web: platformImageTag('web'),
  gateway: platformImageTag('gateway'),
  runner: platformImageTag('runner'),
  runtime: platformImageTag('runtime'),
  postgres: 'docker.io/library/postgres:18-alpine',
  // chrislusf/seaweedfs:4.47, pinned by its multi-arch image index digest: the same digest the
  // S3 contract suite runs against (ADR-0066), so what CI proves is what a project pulls.
  seaweedfs:
    'docker.io/chrislusf/seaweedfs@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882',
};

/** The images a deployment pins, named once so every check over them stays exhaustive. */
const IMAGE_NAMES = ['web', 'gateway', 'runner', 'runtime', 'postgres', 'seaweedfs'] as const;

/**
 * The override this generator read before the bundled object store became SeaweedFS (ADR-0067).
 * It named a MinIO image; honouring it would pin MinIO into a service that now runs `weed`, and
 * ignoring it would silently drop what release engineering asked for, so it is refused by name.
 */
const RETIRED_IMAGE_OVERRIDE = 'AW_MINIO_IMAGE';

export function assertDigestReference(reference: string, name = 'image'): string {
  if (!digestPattern.test(reference) || reference.endsWith(`sha256:${'0'.repeat(64)}`)) {
    throw new Error(`${name} must be a non-placeholder sha256 digest reference`);
  }
  return reference;
}

/**
 * Re-assert the release gate over a whole reference set, whatever produced it. A caller that
 * supplies its own images must clear the same bar as one that let `resolveDeploymentImages` do it,
 * or the gate would have a hole a caller could walk through.
 *
 * The gate covers whatever the set holds: a cloud reference set carries no Compose images, and
 * demanding a pin for an image that deployment never pulls would be a gate on nothing. Every
 * reference that *is* present still has to be a non-placeholder digest.
 */
export function assertDigestReferences(images: DeploymentImages): DeploymentImages {
  for (const name of IMAGE_NAMES) {
    const reference = images[name];
    if (reference !== undefined) assertDigestReference(reference, name);
  }
  return images;
}

function repositoryOf(reference: string): string {
  const lastSlash = reference.lastIndexOf('/');
  const lastColon = reference.lastIndexOf(':');
  return lastColon > lastSlash ? reference.slice(0, lastColon) : reference;
}

/**
 * What an operator can do when a platform image this CLI pins by default cannot be resolved: the
 * usual cause is that the image release for this version has not run, or its packages are not
 * public yet. The generator still refuses; it never writes a project with a mutable tag.
 */
function platformImagesUnavailableHint(): string {
  return (
    `The Agent Workspace platform images for ${PLATFORM_IMAGE_VERSION} are published by ` +
    `${PLATFORM_IMAGES_WORKFLOW} from the tag images-v${PLATFORM_IMAGE_VERSION} on main, and ` +
    'each ghcr.io package must be public for an anonymous pull. If that release has not run yet, ' +
    'set AW_WEB_IMAGE, AW_GATEWAY_IMAGE, AW_RUNNER_IMAGE and AW_RUNTIME_IMAGE to sha256 digest ' +
    'references of images you built, or use a CLI version whose images are published. ' +
    'No project was written.'
  );
}

function resolveTaggedImage(reference: string, releaseDefault = false): string {
  if (reference.includes('@')) return assertDigestReference(reference);
  const result = runDocker(
    ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}'],
    { env: process.env, timeout: DOCKER_COMMAND_TIMEOUT_MS },
  );
  if (result.status !== 0) {
    const cause = result.stderr?.trim() || 'docker buildx failed';
    // A null status means docker never ran to completion (missing or timed out): not the release.
    const hint =
      releaseDefault && result.status !== null ? ` ${platformImagesUnavailableHint()}` : '';
    throw new Error(`Could not resolve immutable digest for ${reference}: ${cause}.${hint}`);
  }
  const digest = manifestDigest(result.stdout);
  if (digest === undefined) throw new Error(`Registry returned no digest for ${reference}`);
  return assertDigestReference(`${repositoryOf(reference)}@${digest}`);
}

function manifestDigest(output: string): string | undefined {
  try {
    const manifest = JSON.parse(output) as { digest?: unknown; Digest?: unknown } | null;
    const digest = manifest?.digest ?? manifest?.Digest;
    return typeof digest === 'string' ? digest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve every image the named deployment shape pulls to an immutable digest.
 *
 * `local` runs the Compose project, so it pins PostgreSQL and SeaweedFS too. A cloud deployment
 * takes its database and its bucket from the cloud, so resolving those two would reach a registry
 * for references nothing in that deployment ever pulls.
 *
 * For each image, an `AW_<NAME>_IMAGE` override wins; then a reference already `pinned` (what an
 * existing project's `.env` holds, which `agent-workspace render` passes), held to the same digest
 * gate; then this CLI's release default. A pin is used as it is, without a registry, so
 * re-rendering a project is offline and never upgrades an image the operator did not ask for.
 */
export function resolveDeploymentImages(
  cloud: DeploymentCloud,
  environment: NodeJS.ProcessEnv = process.env,
  pinned: Partial<DeploymentImages> = {},
): DeploymentImages {
  const resolve = (name: keyof Required<DeploymentImages>): string => {
    const override = environment[`AW_${name.toUpperCase()}_IMAGE`];
    if (override !== undefined) return resolveTaggedImage(override);
    const pin = pinned[name];
    if (pin !== undefined) return assertDigestReference(pin, `the pinned ${name} image`);
    return resolveTaggedImage(releaseTags[name], name !== 'postgres' && name !== 'seaweedfs');
  };
  const platform = {
    web: resolve('web'),
    gateway: resolve('gateway'),
    runner: resolve('runner'),
    runtime: resolve('runtime'),
  };
  if (cloud !== 'local') return platform;
  if (environment[RETIRED_IMAGE_OVERRIDE] !== undefined) {
    throw new Error(
      `${RETIRED_IMAGE_OVERRIDE} is no longer read: the Compose project's object store is ` +
        'SeaweedFS (ADR-0067). Set AW_SEAWEEDFS_IMAGE to a SeaweedFS digest reference instead.',
    );
  }
  return {
    ...platform,
    postgres: resolve('postgres'),
    seaweedfs: resolve('seaweedfs'),
  };
}

/** One line of `.env`, split so a writer can replace the value and keep every other byte. */
type EnvLine =
  | { readonly kind: 'blank' }
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'entry';
      /** Indentation and an `export ` keyword, as written; `''` when the line has neither. */
      readonly prefix: string;
      readonly key: string;
      readonly value: string;
      /** What follows the value: trailing whitespace and an inline `# comment`, or `''`. */
      readonly suffix: string;
    };

const ENV_LINE_PREFIX = /^\s*(?:export\s+)?/u;
const INLINE_COMMENT = /\s#/u;

/**
 * Read one `.env` line (without its line ending) the way Compose's dotenv reader reads the forms
 * an operator writes by hand: an optional `export ` before the name, and, in an unquoted value, a
 * `#` after whitespace starting a comment. A quoted value is taken as it stands. Blank lines and
 * `#` comment lines are `blank`; any other line that is not `NAME=value` is `invalid`.
 */
export function parseEnvLine(line: string): EnvLine {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return { kind: 'blank' };
  const prefix = ENV_LINE_PREFIX.exec(line)?.[0] ?? '';
  const rest = line.slice(prefix.length);
  const separator = rest.indexOf('=');
  if (separator < 1) return { kind: 'invalid' };
  const body = rest.slice(separator + 1);
  let value = body.trimEnd();
  if (!value.startsWith('"') && !value.startsWith("'")) {
    const comment = INLINE_COMMENT.exec(value);
    if (comment !== null) value = value.slice(0, comment.index).trimEnd();
  }
  return {
    kind: 'entry',
    prefix,
    key: rest.slice(0, separator),
    value,
    suffix: body.slice(value.length),
  };
}

/**
 * A wholly quoted value as Compose's dotenv reader gives it: `'…'` literally, `"…"` with `\\`,
 * `\"` and `\n` unescaped. Any other value, including a quoted one followed by a `# comment`, is
 * returned as written. `aw deploy` writes `AW_DEPLOYMENT_POLICY` single-quoted, and a deploy that
 * copied the quotes to a host would make the control plane refuse to start on a policy that "is
 * not JSON".
 */
function unquoted(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== "'" && quote !== '"') || value.at(-1) !== quote) return value;
  const inner = value.slice(1, -1);
  if (quote === "'") return inner.includes("'") ? value : inner;
  return inner.replace(/\\([\\"n])/gu, (_match, escaped: string) =>
    escaped === 'n' ? '\n' : escaped,
  );
}

/** The `.env` entries as Compose reads them: quoted values are unquoted, the last duplicate wins. */
export function parseEnvironment(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = parseEnvLine(rawLine);
    if (line.kind === 'blank') continue;
    if (line.kind === 'invalid') throw new Error(`Invalid .env line: ${rawLine}`);
    parsed[line.key] = unquoted(line.value);
  }
  return parsed;
}

/**
 * The object-store pin a generated `.env` carries. `SEAWEEDFS_IMAGE` since ADR-0067; a project
 * generated before it has its own copy of the MinIO-era `compose.yaml` and a `.env` that pins
 * `MINIO_IMAGE` instead, and `start` keeps holding that project to the digest gate rather than
 * refusing it for a variable its Compose file never reads.
 */
function objectStoreImageKey(environment: Record<string, string>): string {
  if (environment['SEAWEEDFS_IMAGE'] === undefined && environment['MINIO_IMAGE'] !== undefined) {
    return 'MINIO_IMAGE';
  }
  return 'SEAWEEDFS_IMAGE';
}

/**
 * `engineImageEnvName('claude-agent-sdk')` of `packages/runtime` (ENG-07, ADR-0073), restated
 * because the published CLI must not import that private package (ADR-0082's amendment for #364);
 * `packages/embedded/src/runtime-pins.test.ts` holds the two equal.
 */
export const CLAUDE_AGENT_SDK_RUNTIME_IMAGE_KEY = 'AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK';

/**
 * The Claude engine's runtime-image pin a generated `.env` carries.
 * `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK` since ENG-07 (ADR-0073); a project generated
 * before it has its own copy of the older `compose.yaml` and a `.env` that pins `RUNTIME_IMAGE`,
 * and `start` keeps holding that project to the digest gate rather than refusing it.
 */
function runtimeImageKey(environment: Record<string, string>): string {
  const current = CLAUDE_AGENT_SDK_RUNTIME_IMAGE_KEY;
  if (environment[current] === undefined && environment['RUNTIME_IMAGE'] !== undefined) {
    return 'RUNTIME_IMAGE';
  }
  return current;
}

/**
 * The longest project name accepted. It is also the session cookie's suffix (`AW_INSTANCE_ID`,
 * issue #394), which the web service keeps to 63 characters; `create` writes at most 48.
 */
const COMPOSE_PROJECT_NAME_MAX_LENGTH = 63;

/**
 * Refuse a `COMPOSE_PROJECT_NAME` that `create` would never have written, before any command acts
 * on it: one Compose rejects or that could widen a Docker `--filter`, one too long to scope the
 * session cookie by, or `agent-workspace`, the repository's development stack, which `stop` would
 * otherwise take down. Returns the name.
 */
export function assertComposeProjectName(value: string | undefined): string {
  const project = value?.trim() ?? '';
  const fix =
    `Set it in .env to the name \`${COMPOSE_PROJECT_CREATE_COMMAND}\` generated: lowercase ` +
    'letters, digits, "-" and "_", starting with a letter or digit, at most ' +
    `${String(COMPOSE_PROJECT_NAME_MAX_LENGTH)} characters. A kind: Project directory runs with ` +
    '`aw dev` instead.';
  if (!COMPOSE_PROJECT_NAME_PATTERN.test(project)) {
    throw new Error(
      `COMPOSE_PROJECT_NAME ${JSON.stringify(project)} is not a Compose project name. ${fix}`,
    );
  }
  if (project.length > COMPOSE_PROJECT_NAME_MAX_LENGTH) {
    throw new Error(
      `COMPOSE_PROJECT_NAME is ${String(project.length)} characters long; it also names the ` +
        `session cookie, so it must be at most ${String(COMPOSE_PROJECT_NAME_MAX_LENGTH)}. ${fix}`,
    );
  }
  if (project === RESERVED_COMPOSE_PROJECT_NAME) {
    throw new Error(
      `COMPOSE_PROJECT_NAME "${RESERVED_COMPOSE_PROJECT_NAME}" is reserved for the repository's own ` +
        'development stack, which this command must never act on. Rename the project in .env.',
    );
  }
  return project;
}

export function validateDeploymentEnvironment(environment: Record<string, string>): void {
  // Absent, Compose itself refuses the generated `compose.yaml` (`${COMPOSE_PROJECT_NAME:?}`).
  if (environment['COMPOSE_PROJECT_NAME'] !== undefined) {
    assertComposeProjectName(environment['COMPOSE_PROJECT_NAME']);
  }
  for (const key of [
    'WEB_IMAGE',
    'GATEWAY_IMAGE',
    'RUNNER_IMAGE',
    runtimeImageKey(environment),
    'POSTGRES_IMAGE',
    objectStoreImageKey(environment),
  ]) {
    assertDigestReference(environment[key] ?? '', key);
  }
  if (environment['RUNTIME_DRIVER'] !== 'docker') {
    throw new Error(
      `Configured runtime ${JSON.stringify(environment['RUNTIME_DRIVER'])} disagrees with generated topology runtime "docker"`,
    );
  }
}

/**
 * What `docker compose up` writes when the host port `web` publishes is taken on the Docker host:
 * the engine's `address already in use`, `port is already allocated` when another container holds
 * it, or Docker Desktop's `ports are not available` (whose WinSock tail is localised on Windows).
 * Compose leaves every service it had already started running.
 */
const HOST_PORT_IN_USE =
  /failed to bind host port|address already in use|port is already allocated|ports are not available/iu;

/** Where the web URL points when the Docker daemon runs on this machine. */
const LOCAL_WEB_HOST = '127.0.0.1';

/** What happened to the project when its web port turned out to be taken. */
type PortConflictOutcome = 'not-started' | 'stopped' | 'stop-failed';

/**
 * The failed-start message for a host port the web service cannot be published on: the same
 * guidance `start` gives when another process answers on the port (`describePortConflict`), plus
 * what happened to the project. The pre-flight check (`assertWebPortFree`) finds the port taken
 * before anything starts; a bind failure of `compose up` finds it after some services started.
 */
function describeHostPortInUse(url: string, outcome: PortConflictOutcome, holder?: string): string {
  const port = new URL(url).port || '80';
  const cleanup = {
    'not-started': 'Nothing was started.',
    stopped:
      'The services it had already started were stopped with `docker compose down`; the data ' +
      'volumes are kept.',
    'stop-failed':
      'Stopping the services it had already started failed: run `docker compose down` in this ' +
      'directory (the data volumes are kept).',
  }[outcome];
  const subject =
    outcome === 'not-started'
      ? `The web service cannot be published on ${url}`
      : `docker compose could not publish the web service on ${url}`;
  return (
    `${subject}: port ${port} is already in use on the Docker host` +
    `${holder === undefined ? '' : ` (${holder})`}. Stop the process holding port ${port}, or ` +
    `set PORT in .env to a free port, and run \`agent-workspace start\` again. ${cleanup}`
  );
}

/** Runs one `docker` command to completion; injected by the suite. */
export type DockerCommand = (
  argv: readonly string[],
  options: { readonly cwd?: string; readonly env: NodeJS.ProcessEnv; readonly timeout: number },
) => { readonly status: number | null; readonly stdout: string; readonly stderr?: string };

export const runDocker: DockerCommand = (argv, options) => {
  const result = spawnSync('docker', [...argv], {
    ...options,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const missing = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: missing ? 'docker is not installed or not on PATH' : stderr,
  };
};

/**
 * How long `start` waits for the daemon to report its socket's group. The first run may pull the
 * PostgreSQL image, which `docker compose up` pulls next anyway; past this, `start` keeps the
 * `.env` value, and the runner check after `up` names `DOCKER_GID` if that value is wrong.
 */
export const DOCKER_SOCKET_GROUP_PROBE_TIMEOUT_MS = 120_000;

/** How long `start` waits for `docker compose down`, or for the runner's socket check. */
const DOCKER_COMMAND_TIMEOUT_MS = 60_000;

/**
 * The group that owns `/var/run/docker.sock` on the Docker daemon Compose talks to, read by a
 * short-lived container of the project's already digest-pinned PostgreSQL image (its `stat`) that
 * mounts the socket exactly as the runner does. Statting this machine's file instead is wrong
 * whenever the daemon is elsewhere: `DOCKER_HOST` or a docker context naming a remote, VM or
 * docker-in-docker daemon, or Windows and macOS with a remote Linux daemon (#389).
 *
 * `undefined` when the daemon gives no usable answer in time; the caller keeps `.env`'s value.
 */
export function daemonSocketGroupId(
  environment: NodeJS.ProcessEnv,
  image: string,
  run: DockerCommand = runDocker,
): number | undefined {
  const result = run(
    [
      'run',
      '--rm',
      '--quiet',
      '--network',
      'none',
      '--entrypoint',
      'stat',
      '--volume',
      '/var/run/docker.sock:/var/run/docker.sock:ro',
      image,
      '-c',
      '%g',
      '/var/run/docker.sock',
    ],
    { env: environment, timeout: DOCKER_SOCKET_GROUP_PROBE_TIMEOUT_MS },
  );
  const answer = result.stdout.trim();
  if (result.status !== 0 || !/^\d{1,10}$/u.test(answer)) return undefined;
  return Number(answer);
}

/**
 * Set the `DOCKER_GID` the runner joins for this start. The daemon's answer wins over `.env`: it
 * is the group the mounted socket really has, and on native Linux and Docker Desktop it equals the
 * value the generator wrote, so nothing changes there. A different answer is used for this run and
 * reported; `.env` is left as the operator wrote it.
 */
function applyDaemonSocketGroupId(
  environment: Record<string, string>,
  composeEnvironment: NodeJS.ProcessEnv,
  run: DockerCommand,
): void {
  const image = environment['POSTGRES_IMAGE'];
  if (image === undefined) return;
  // It lands in `docker run`'s argv: a leading `-` would be read as an option, not an image.
  if (image.startsWith('-')) {
    throw new Error(`POSTGRES_IMAGE in .env must be an image reference, not ${image}`);
  }
  process.stdout.write('Checking the Docker socket group on the daemon…\n');
  const probed = daemonSocketGroupId(composeEnvironment, image, run);
  if (probed === undefined) return;
  const groupId = String(probed);
  const configured = environment['DOCKER_GID'];
  if (configured === groupId) return;
  composeEnvironment['DOCKER_GID'] = groupId;
  process.stdout.write(
    `The Docker socket on the daemon belongs to group ${groupId}, not DOCKER_GID=` +
      `${configured ?? '(unset)'} in .env; the runner joins group ${groupId} for this start. ` +
      `Set DOCKER_GID=${groupId} in .env to record it.\n`,
  );
}

/**
 * The runner's own view of the socket once it is up: a `/_ping` over `/var/run/docker.sock` as the
 * runner's user. Exit 13 is `EACCES`, the one answer that names `DOCKER_GID`; anything else (a
 * runner image without `node`, a daemon hiccup) is not this check's to fail a start on.
 */
export const RUNNER_SOCKET_PING =
  "require('node:http').get({socketPath:'/var/run/docker.sock',path:'/_ping'}," +
  'r=>{r.resume();process.exit(r.statusCode===200?0:1)})' +
  ".on('error',e=>process.exit(e.code==='EACCES'?13:1))";

function describeRunnerSocketDenied(dockerGroupId: string | undefined): string {
  return (
    'The runner cannot use the Docker socket: permission denied on /var/run/docker.sock, so the ' +
    'Docker runtime cannot start a sandbox. The runner joins group ' +
    `DOCKER_GID=${dockerGroupId ?? '(unset)'}, which does not match the socket group, or ` +
    'SELinux/AppArmor denies the socket. Set DOCKER_GID in ' +
    '.env to the group id of /var/run/docker.sock on the Docker host (`stat -c %g ' +
    '/var/run/docker.sock` there) and run `agent-workspace start` again. The containers are left ' +
    'running; `docker compose down` stops the project.'
  );
}

function assertRunnerCanUseSocket(
  directory: string,
  composeEnvironment: NodeJS.ProcessEnv,
  run: DockerCommand,
): void {
  const result = run(['compose', 'exec', '-T', 'runner', 'node', '-e', RUNNER_SOCKET_PING], {
    cwd: directory,
    env: composeEnvironment,
    timeout: DOCKER_COMMAND_TIMEOUT_MS,
  });
  if (result.status === 13) {
    throw new Error(describeRunnerSocketDenied(composeEnvironment['DOCKER_GID']));
  }
}

/** Runs `docker compose up`, showing its stderr and returning it; injected by the suite. */
export type ComposeUp = (
  directory: string,
  environment: NodeJS.ProcessEnv,
) => Promise<{ readonly status: number; readonly stderr: string }>;

const composeUp: ComposeUp = (directory, environment) => {
  const compose = spawn('docker', ['compose', 'up', '--detach', '--wait', '--remove-orphans'], {
    cwd: directory,
    env: environment,
    // stderr is read as well as shown, so a host-port bind failure can be told from any other.
    stdio: ['inherit', 'inherit', 'pipe'],
    shell: false,
  });
  let stderr = '';
  compose.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    stderr += chunk.toString('utf8');
  });
  return new Promise((resolve, reject) => {
    compose.once('error', reject);
    compose.once('close', (code: number | null) => {
      resolve({ status: code ?? 1, stderr });
    });
  });
};

/** The Docker calls `start` makes; injected by the suite. */
export interface StartComposeOptions {
  readonly up?: ComposeUp;
  readonly docker?: DockerCommand;
  readonly inspect?: DockerContextInspector;
  readonly hostPortFree?: HostPortProbe;
}

/** Whether this machine can bind a TCP port on every address; injected by the suite. */
export type HostPortProbe = (port: number) => Promise<boolean>;

/**
 * Bind the port the way Docker publishes it (every address) and let it go again. Only
 * `EADDRINUSE` reads as taken: any other refusal is left for `compose up` to report, since the
 * Docker daemon, not this process, does the real bind.
 */
export const hostPortFree: HostPortProbe = (port) =>
  new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code !== 'EADDRINUSE');
    });
    server.listen({ port, exclusive: true }, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });

/** How long `start` waits for `docker ps` to list the daemon's published ports. */
const DOCKER_PS_TIMEOUT_MS = 30_000;

/**
 * Whether a `docker ps` Ports column publishes `port` on the host: a single port
 * (`0.0.0.0:3000->3000/tcp`) or a range that covers it (`0.0.0.0:3000-3005->3000-3005/tcp`).
 */
function publishesHostPort(ports: string, port: number): boolean {
  for (const match of ports.matchAll(/:(\d+)(?:-(\d+))?->/gu)) {
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    if (port >= first && port <= last) return true;
  }
  return false;
}

/** How this project's own containers are recognised in `docker ps`. */
interface OwnProject {
  /** `path.resolve` of the project directory: Compose's `project.working_dir` label. */
  readonly workingDir: string;
  /** `COMPOSE_PROJECT_NAME` from the shell or `.env`, when it is set. */
  readonly name: string | undefined;
}

/**
 * Which project's container publishes the web port, if any. A container is this project's own
 * when Compose labelled it with this directory as its working directory, or with the
 * `COMPOSE_PROJECT_NAME` this start runs under. A name derived from the directory's basename is not
 * used: another project in a directory of the same name would pass for this one.
 */
/**
 * A directory's physical path, or its resolved path when it cannot be read (a daemon's path that
 * does not exist here). Compose records the logical `$PWD`, which may pass through a symlink, while
 * Node's `process.cwd()` is physical, so both sides are compared physically.
 */
function realPathOrResolved(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return path.resolve(directory);
  }
}

function isOwnContainer(project: string, workingDir: string, own: OwnProject): boolean {
  if (workingDir !== '' && realPathOrResolved(workingDir) === own.workingDir) return true;
  return own.name !== undefined && project === own.name;
}

/** What `docker ps` says about the port: unknown, free of containers, ours, or another's. */
type PublishedPort =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'free' }
  | { readonly kind: 'ours' }
  | { readonly kind: 'taken'; readonly holder: string };

function containerPublishing(
  port: number,
  own: OwnProject,
  environment: NodeJS.ProcessEnv,
  docker: DockerCommand,
): PublishedPort {
  const listing = docker(
    [
      'ps',
      '--format',
      '{{.Label "com.docker.compose.project"}}\t' +
        '{{.Label "com.docker.compose.project.working_dir"}}\t{{.Names}}\t{{.Ports}}',
    ],
    { env: environment, timeout: DOCKER_PS_TIMEOUT_MS },
  );
  // A daemon that cannot list its containers fails `compose up` with its own message.
  if (listing.status !== 0) return { kind: 'unknown' };
  for (const line of listing.stdout.split(/\r?\n/u)) {
    const [project = '', workingDir = '', name = '', ports = ''] = line.split('\t');
    if (!publishesHostPort(ports, port)) continue;
    if (isOwnContainer(project, workingDir, own)) return { kind: 'ours' };
    return {
      kind: 'taken',
      holder:
        project === ''
          ? `by container ${name}`
          : `by container ${name} of Compose project ${project}`,
    };
  }
  return { kind: 'free' };
}

/**
 * Refuse a taken web port before `compose up`, which otherwise pulls every image and starts
 * postgres, the runner and the gateway before it reaches the web bind (#396). The daemon's own
 * published ports are asked first, local or remote: a container of this project holding the port
 * is the project already running, which `up` leaves as it is. Only when that listing shows no
 * container on the port, and the daemon is local, is the port bound on this machine, which also
 * finds a process that is not a container. When the listing fails, a failed bind could be this
 * project's own container, so nothing is refused here. A remote daemon's host cannot be bound from
 * here at all. In both cases the bind failure of `compose up` is translated as before.
 */
async function assertWebPortFree(
  url: string,
  own: OwnProject,
  composeEnvironment: NodeJS.ProcessEnv,
  probes: { readonly docker: DockerCommand; readonly hostPortFree: HostPortProbe },
): Promise<void> {
  const { hostname, port: urlPort } = new URL(url);
  const port = Number(urlPort || '80');
  const published = containerPublishing(port, own, composeEnvironment, probes.docker);
  if (published.kind === 'taken') {
    throw new Error(describeHostPortInUse(url, 'not-started', published.holder));
  }
  if (published.kind !== 'free' || hostname !== LOCAL_WEB_HOST) return;
  if (!(await probes.hostPortFree(port))) {
    throw new Error(describeHostPortInUse(url, 'not-started'));
  }
}

/** Bring the Compose topology up and return the URL its web service answers on. */
export async function startComposeDeployment(
  directory = process.cwd(),
  options: StartComposeOptions = {},
): Promise<string> {
  const up = options.up ?? composeUp;
  const docker = options.docker ?? runDocker;
  const environment = parseEnvironment(await readFile(path.join(directory, '.env'), 'utf8'));
  validateDeploymentEnvironment(environment);
  // Compose runs with `.env` layered over the shell, so a DOCKER_HOST set in `.env` is the daemon
  // it talks to, and the one whose host the web port is published on.
  const composeEnvironment: NodeJS.ProcessEnv = { ...process.env, ...environment };
  const url = webUrl(environment, dockerEndpoint(composeEnvironment, options.inspect));
  const configuredName = composeEnvironment['COMPOSE_PROJECT_NAME'];
  const own: OwnProject = {
    workingDir: realPathOrResolved(directory),
    name: configuredName === undefined || configuredName === '' ? undefined : configuredName,
  };
  await assertWebPortFree(url, own, composeEnvironment, {
    docker,
    hostPortFree: options.hostPortFree ?? hostPortFree,
  });
  applyDaemonSocketGroupId(environment, composeEnvironment, docker);
  const { status, stderr } = await up(directory, composeEnvironment);
  if (status !== 0) {
    if (!HOST_PORT_IN_USE.test(stderr)) {
      throw new Error(`docker compose exited with status ${String(status)}`);
    }
    // Compose leaves the services it had already started running; nothing of this start is
    // usable without its web port, so they are stopped. `down` keeps the named volumes.
    const down = docker(['compose', 'down'], {
      cwd: directory,
      env: composeEnvironment,
      timeout: DOCKER_COMMAND_TIMEOUT_MS,
    });
    throw new Error(describeHostPortInUse(url, down.status === 0 ? 'stopped' : 'stop-failed'));
  }
  assertRunnerCanUseSocket(directory, composeEnvironment, docker);
  process.stdout.write('Configured runtime: docker; effective runtime: docker\n');
  return url;
}

/** Runs `docker context inspect`; injected by the suite. */
export type DockerContextInspector = (environment: NodeJS.ProcessEnv) => {
  readonly status: number | null;
  readonly stdout: string;
};

/**
 * `docker context inspect` reads local context metadata and never calls the daemon, so this bounds
 * a stuck docker CLI, not a hung daemon; a killed process reads as an unreadable endpoint.
 */
export const DOCKER_CONTEXT_INSPECT_TIMEOUT_MS = 5_000;

function inspectDockerContext(environment: NodeJS.ProcessEnv) {
  return spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
    encoding: 'utf8',
    env: environment,
    shell: false,
    timeout: DOCKER_CONTEXT_INSPECT_TIMEOUT_MS,
  });
}

/**
 * The daemon endpoint `docker compose` uses with this environment: `DOCKER_HOST` when it is set,
 * otherwise the endpoint of the current `docker context` (which `DOCKER_CONTEXT` selects). An
 * endpoint that cannot be read is `undefined`, and the web URL falls back to this machine.
 */
export function dockerEndpoint(
  environment: NodeJS.ProcessEnv,
  inspect: DockerContextInspector = inspectDockerContext,
): string | undefined {
  const host = environment['DOCKER_HOST'];
  if (host !== undefined && host !== '') return host;
  const result = inspect(environment);
  const endpoint = result.status === 0 ? result.stdout.trim() : '';
  return endpoint === '' ? undefined : endpoint;
}

/**
 * Where the published web port answers. Compose publishes it on the Docker host, which is this
 * machine unless `DOCKER_HOST` names a remote daemon over `tcp://` or `ssh://`; a local socket or
 * pipe (`unix://`, `npipe://`) is this machine.
 */
export function webUrl(environment: Record<string, string>, dockerHost?: string): string {
  // Compose's `ip:port` short form publishes on that address only (`aw deploy` sets loopback).
  const published = environment['PORT'] || '3000';
  const separator = published.lastIndexOf(':');
  const port = published.slice(separator + 1);
  let host = separator === -1 ? LOCAL_WEB_HOST : published.slice(0, separator);
  if (dockerHost !== undefined && /^(?:tcp|ssh):\/\//u.test(dockerHost)) {
    try {
      const { hostname } = new URL(dockerHost);
      if (hostname !== '') host = hostname;
    } catch {
      // An unparsable DOCKER_HOST is docker's to refuse; this machine is the only address left.
    }
  }
  return `http://${host}:${port}`;
}

/**
 * The generator's `DOCKER_GID`: the group of this machine's socket on Linux, else 0 (Docker
 * Desktop's socket). Generating pulls and runs nothing, so this is only a default: `start` asks the
 * daemon it actually talks to (`daemonSocketGroupId`) and uses that answer when the two differ.
 */
export async function dockerSocketGroupId(): Promise<number> {
  if (process.platform !== 'linux') return 0;
  try {
    return (await stat('/var/run/docker.sock')).gid;
  } catch {
    return 0;
  }
}
