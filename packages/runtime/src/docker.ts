/**
 * The Docker runtime driver. One `create()` call starts one hardened container and one
 * `destroy()` call removes that exact container.
 *
 * The agent transport stays injected, just as it does for `local`: the runtime package owns the
 * isolation boundary, while the runner owns the SDK and the HTTP/SSE adapter. This keeps the
 * dependency-free runtime package on the correct side of spec section 42.
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import type {
  AgentConnection,
  RuntimeCapabilities,
  RuntimeConfig,
  RuntimeDriver,
  RuntimeHandle,
} from './driver.js';
import {
  EGRESS_PROXY_PORT,
  egressAllowlist,
  egressProxyEnvironment,
  requireEgressProxyImage,
  requireProxyBypass,
} from './egress.js';
import { assertDigestPinnedEngineImages, requireEngineImage } from './engine-images.js';
import type { EngineImageMap } from './engine-images.js';
import { RuntimeRefusalError } from './external/errors.js';

export type DockerNetworkPolicy = 'none' | 'restricted' | 'open';

export type DockerPolicyEnforcement = Readonly<{
  none: 'network';
  restricted: 'proxy';
  open: 'network' | 'proxy';
}>;

export type DockerRuntimeCapabilities = RuntimeCapabilities &
  Readonly<{ networkPolicyEnforcement: DockerPolicyEnforcement }>;

export const DOCKER_RUNTIME_CAPABILITIES: DockerRuntimeCapabilities = {
  isolation: 'container',
  customImage: true,
  persistentFilesystem: true,
  sessionAffinity: true,
  maxSessionSeconds: null,
  networkPolicies: ['none', 'open'],
  execCommands: true,
  gpu: false,
  managedByProvider: false,
  typicalStartMs: 500,
  fileTransfer: 'push-archive',
  networkPolicyEnforcement: {
    none: 'network',
    restricted: 'proxy',
    open: 'network',
  },
};

/**
 * With an `egressProxyImage` the driver proxies `restricted` and `open` (ADR-0117), so it claims
 * `allowlist` and enforces `open` through the proxy; without one it keeps {@link DOCKER_RUNTIME_CAPABILITIES}.
 */
export const DOCKER_PROXIED_RUNTIME_CAPABILITIES: DockerRuntimeCapabilities = {
  ...DOCKER_RUNTIME_CAPABILITIES,
  networkPolicies: ['none', 'allowlist', 'open'],
  networkPolicyEnforcement: { none: 'network', restricted: 'proxy', open: 'proxy' },
};

export type DockerCommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

/** `input` is written to the command's standard input, so content never appears in an argument. */
export type DockerCommand = (
  args: readonly string[],
  options?: Readonly<{ input?: string }>,
) => Promise<DockerCommandResult>;

export type DockerAgentStarter<TRequest, TEvent> = (
  runtime: RuntimeHandle,
  request: TRequest,
) => AgentConnection<TEvent> | Promise<AgentConnection<TEvent>>;

export type DockerDriverOptions<TRequest, TEvent> = Readonly<{
  /**
   * ENG-07: one image per engine, and `create()` picks the one for `config.engine`. A map rather
   * than a string because a single image would have to carry every adapter, and an image that
   * carries every adapter carries every adapter's third-party SDK into every sandbox.
   */
  images: EngineImageMap;
  startAgent: DockerAgentStarter<TRequest, TEvent>;
  networkPolicy?: DockerNetworkPolicy;
  networkName?: string;
  command?: readonly string[];
  docker?: DockerCommand;
  /** Production managers set this so mutable tags cannot cross the runtime boundary. */
  requireDigest?: boolean;
  /**
   * Managers running inside containers use `anonymous-volume`: `/workspace` is a size-bounded
   * tmpfs (`diskMb`, default {@link DOCKER_DEFAULT_WORKSPACE_MB}) that disappears with the
   * container. `bind` is the local/dev fallback: a host directory cannot be sized by Docker, so it
   * is unbounded and an explicit `diskMb` is refused rather than silently ignored.
   */
  workspaceStorage?: 'bind' | 'anonymous-volume';
  /**
   * The Compose project this driver's sandboxes belong to (issue #394). Every sandbox, and an
   * internal network this driver has to create, carries it as {@link DOCKER_COMPOSE_PROJECT_LABEL},
   * so `agent-workspace stop` and {@link DockerDriver.reapAll} can find them after the process
   * that started them is gone. Unset outside a Compose project: nothing is labelled, and
   * `reapAll` removes only the sandboxes this process still holds.
   */
  composeProject?: string;
  /**
   * `loopback` publishes each sandbox's runtime port on an ephemeral `127.0.0.1` port and maps
   * `host.docker.internal` to the host, for a manager that runs on the host instead of on the
   * sandboxes' network: the local runtime's `aw dev --sandbox docker` (#786). Container names do
   * not resolve there, so the manager reaches a sandbox at {@link DockerDriver.publishedOrigin}.
   * An internal network publishes nothing, so only the `open` policy is accepted.
   */
  publish?: 'loopback';
  /**
   * The `packages/egress-proxy` image (ADR-0117). When set, `create()` starts one proxy container
   * per `restricted` or `open` session: the sandbox keeps no route out except through it, which
   * makes `restricted` + `allowedDomains` work and keeps `open` off the metadata endpoint and the
   * LAN. When unset the driver keeps refusing `restricted` and `allowedDomains`, and `open` stays
   * the unproxied Docker `bridge`.
   */
  egressProxyImage?: string;
  /** Hosts a proxied sandbox reaches directly (`NO_PROXY`), typically the gateway's name. */
  proxyBypass?: readonly string[];
}>;

/** What {@link DockerDriver.reapAll} removed, and what it could not. Never thrown. */
export type DockerReapReport = Readonly<{
  removed: readonly string[];
  failed: readonly Readonly<{ container: string; reason: string }>[];
}>;

export type DockerDriver<TRequest, TEvent> = RuntimeDriver<TRequest, TEvent> &
  Readonly<{
    capabilities: DockerRuntimeCapabilities;
    isLive(runtime: RuntimeHandle): Promise<boolean>;
    /**
     * Remove every sandbox this driver owns: each handle it still holds and, when
     * `composeProject` is set, every container carrying both {@link DOCKER_SANDBOX_LABEL} and that
     * project's {@link DOCKER_COMPOSE_PROJECT_LABEL}, which covers the sandboxes an earlier process
     * of the same project left behind. A container without both labels is never touched. The
     * runner manager calls this on `SIGTERM`, so `docker compose down` does not leave sandboxes
     * holding the project's runtime-control network.
     */
    reapAll(): Promise<DockerReapReport>;
    /**
     * Remove every sandbox this driver holds whose `expiresAt` has passed. The driver also calls
     * this every {@link DOCKER_REAP_INTERVAL_MS} while it holds a sandbox with a deadline, so a
     * run is cut off at its `timeoutSeconds` without a manager shutdown. A removal that fails
     * keeps the handle and is retried on the next tick. A reaped handle reads as not live and its
     * `destroy()` succeeds as a no-op, because the manager still holds it.
     */
    reapExpired(): Promise<DockerReapReport>;
    /**
     * Write one file into `/workspace` of a live sandbox, atomically (a reader sees the whole file
     * or none of it). The content travels over `docker exec`'s standard input, never as an argument
     * or an environment variable, so it is not visible in a process list. `name` is a plain file
     * name: no directory part.
     */
    writeFile(runtime: RuntimeHandle, name: string, content: string): Promise<void>;
    /**
     * `http://127.0.0.1:<port>`, where a live sandbox's runtime port is published. Only a driver
     * created with `publish: 'loopback'` has one; any other handle throws.
     */
    publishedOrigin(runtime: RuntimeHandle): string;
  }>;

/** How often the driver checks its sandboxes against their deadlines. */
export const DOCKER_REAP_INTERVAL_MS = 15_000;

/**
 * Docker's answer to an `rm` of a container another call (a reaper tick, `destroy`) is still
 * removing. That removal may yet fail, so the `rm` is repeated until it settles.
 */
const DOCKER_REMOVAL_IN_PROGRESS = /removal of container \S+ is already in progress/iu;
const DOCKER_REMOVAL_ATTEMPTS = 50;
const DOCKER_REMOVAL_RETRY_MS = 200;

/** The agent's `--memory` budget when the run spec sets no `memoryMb`. */
const DOCKER_DEFAULT_MEMORY_MB = 1_024;

/** The port the runtime image serves the section 14.3 contract on. */
const DOCKER_RUNTIME_PORT = '8080/tcp';

/** The `/workspace` tmpfs size when the run spec sets no `diskMb`. */
export const DOCKER_DEFAULT_WORKSPACE_MB = 1_024;

const DOCKER_MIN_WORKSPACE_MB = 16;

/** Execute Docker without a shell, preserving the argument vector byte for byte. */
export const runDockerCommand: DockerCommand = async (args, options) =>
  await new Promise<DockerCommandResult>((resolve, reject) => {
    const child = spawn('docker', [...args], { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.stdin.once('error', reject);
    child.once('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });
    child.stdin.end(options?.input);
  });

function requireValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`docker runtime: ${name} must be a non-empty string.`);
  }
  return value;
}

function requireSuccessful(result: DockerCommandResult, operation: string): DockerCommandResult {
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`;
    throw new Error(`docker runtime: ${operation} failed: ${detail}`);
  }
  return result;
}

const WORKSPACE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const DOCKER_NETWORK_OWNERSHIP_LABEL = 'agent-workspace.runtime';
const DOCKER_NETWORK_OWNERSHIP_VALUE = 'docker-network';

/** The label every sandbox this driver starts carries; `agent-workspace stop` filters on it. */
export const DOCKER_SANDBOX_LABEL = 'agent-workspace.runtime=docker';

/**
 * The label naming the Compose project a sandbox belongs to (issue #394). Deliberately not
 * Compose's own `com.docker.compose.project`: a container carrying that label but no
 * `com.docker.compose.service` is an orphan to Compose, which `up --remove-orphans` would remove
 * mid-run and other Compose commands warn about.
 */
export const DOCKER_COMPOSE_PROJECT_LABEL = 'agent-workspace.compose-project';

/** Compose's own rule for a project name, so the label value can never widen a `--filter`. */
const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;

/** Validate a Compose project name before it reaches a label or a `--filter`. */
export function requireComposeProject(value: string): string {
  if (!COMPOSE_PROJECT_PATTERN.test(value)) {
    throw new Error(
      `docker runtime: composeProject ${JSON.stringify(value)} is not a Compose project name (lowercase letters, digits, "-" and "_", starting with a letter or digit).`,
    );
  }
  return value;
}

// Refuses the policies a deployment without an egress proxy cannot enforce, then resolves the
// proxy allowlist. null: no proxy (policy `none`, `restricted` with nothing allowed, or no proxy image).
// A refusal is `network_policy_unsupported`, so the runner manager answers 422 with that code
// rather than a nameless 500 (BH061-030).
function resolveEgressAllowlist(
  proxyImage: string | undefined,
  policy: DockerNetworkPolicy,
  allowedDomains: readonly string[] | undefined,
): string | null {
  if (proxyImage === undefined) {
    if (policy === 'restricted') {
      throw new RuntimeRefusalError(
        'network_policy_unsupported',
        'docker runtime: restricted network policy requires an allowlist proxy; configure egressProxyImage (ADR-0117).',
      );
    }
    if (allowedDomains !== undefined && allowedDomains.length > 0) {
      throw new RuntimeRefusalError(
        'network_policy_unsupported',
        'docker runtime: allowedDomains requires restricted proxy enforcement; configure egressProxyImage (ADR-0117).',
      );
    }
    return null;
  }
  return egressAllowlist('docker', policy, allowedDomains);
}

function requireDiskMb(
  diskMb: number | undefined,
  workspaceStorage: 'bind' | 'anonymous-volume',
): void {
  if (diskMb === undefined) return;
  if (!Number.isSafeInteger(diskMb) || diskMb < DOCKER_MIN_WORKSPACE_MB) {
    throw new Error(
      `docker runtime: diskMb must be a safe integer of at least ${String(DOCKER_MIN_WORKSPACE_MB)}.`,
    );
  }
  if (workspaceStorage === 'bind') {
    throw new Error(
      'docker runtime: diskMb cannot be enforced on a host bind mount; use workspaceStorage "anonymous-volume" for a sized tmpfs workspace.',
    );
  }
}

function commandFailure(error: unknown): DockerCommandResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
  };
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function validateInternalNetworkInspection(result: DockerCommandResult, networkName: string): void {
  let decoded: unknown;
  try {
    decoded = parseJson(result.stdout);
  } catch {
    throw new Error(
      `docker runtime: refusing network ${JSON.stringify(networkName)} because docker network inspect returned malformed JSON.`,
    );
  }
  if (!Array.isArray(decoded) || decoded.length !== 1) {
    throw new Error(
      `docker runtime: refusing network ${JSON.stringify(networkName)} because docker network inspect did not return exactly one network.`,
    );
  }
  const inspected = (decoded as unknown[])[0];
  if (typeof inspected !== 'object' || inspected === null || Array.isArray(inspected)) {
    throw new Error(
      `docker runtime: refusing network ${JSON.stringify(networkName)} because docker network inspect returned an invalid network object.`,
    );
  }
  const network = inspected as Record<string, unknown>;
  const labels = network['Labels'];
  const owned =
    typeof labels === 'object' &&
    labels !== null &&
    !Array.isArray(labels) &&
    (labels as Record<string, unknown>)[DOCKER_NETWORK_OWNERSHIP_LABEL] ===
      DOCKER_NETWORK_OWNERSHIP_VALUE;
  const problems: string[] = [];
  if (network['Name'] !== networkName) problems.push('its inspected name does not match');
  if (network['Driver'] !== 'bridge') problems.push('it is not a bridge network');
  if (network['Internal'] !== true) problems.push('it is not internal');
  if (!owned) {
    problems.push(
      `it lacks ownership label ${DOCKER_NETWORK_OWNERSHIP_LABEL}=${DOCKER_NETWORK_OWNERSHIP_VALUE}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `docker runtime: refusing network ${JSON.stringify(networkName)} because ${problems.join('; ')}. Remove or recreate it as an internal bridge with --label ${DOCKER_NETWORK_OWNERSHIP_LABEL}=${DOCKER_NETWORK_OWNERSHIP_VALUE}.`,
    );
  }
}

/**
 * Generate the complete `docker run` vector. The security defaults are the fenced command in
 * spec section 14.4. `anonymous-volume` mounts `/workspace` as a tmpfs of `workspaceMb` (the
 * daemon-owned volume it replaces was deleted with the container anyway); `bind` mounts a host
 * path, which Docker cannot size. `none` deliberately means the internal `agent-egress` network, not Docker's
 * all-or-nothing `--network none`: the gateway must remain reachable.
 */
export function buildDockerRunArgs(
  input: Readonly<{
    name: string;
    image: string;
    workspacePath: string;
    networkPolicy: DockerNetworkPolicy;
    networkName: string;
    command?: readonly string[];
    runtimeId?: string;
    sessionId?: string;
    cpu?: number;
    memoryMb?: number;
    workspaceMb?: number;
    filesystem?: 'read-only' | 'read-write';
    workspaceStorage?: 'bind' | 'anonymous-volume';
    composeProject?: string;
    publish?: 'loopback';
    /** Passed as `--env`; a proxied sandbox gets the proxy variables here. */
    env?: Readonly<Record<string, string>>;
  }>,
): readonly string[] {
  const readOnly = input.filesystem === 'read-only';
  const tmpfsWorkspace = input.workspaceStorage === 'anonymous-volume';
  const workspaceMb = input.workspaceMb ?? DOCKER_DEFAULT_WORKSPACE_MB;
  // tmpfs pages are charged to the memory cgroup, so the container's --memory covers the agent's
  // memory plus its tmpfs workspace: the agent keeps its full budget and a full workspace hits
  // ENOSPC instead of an OOM kill.
  const memoryMb =
    (input.memoryMb ?? DOCKER_DEFAULT_MEMORY_MB) + (tmpfsWorkspace ? workspaceMb : 0);
  const workspaceMount = tmpfsWorkspace
    ? [
        '--tmpfs',
        `/workspace:${readOnly ? 'ro' : 'rw'},exec,nosuid,nodev,size=${String(workspaceMb)}m,uid=1000,gid=1000,mode=0700`,
      ]
    : [
        '--mount',
        `type=bind,src=${input.workspacePath},dst=/workspace${readOnly ? ',readonly' : ''}`,
      ];
  const network = input.networkPolicy === 'open' ? 'bridge' : input.networkName;
  return [
    'run',
    '--detach',
    '--name',
    input.name,
    '--label',
    DOCKER_SANDBOX_LABEL,
    ...(input.composeProject === undefined
      ? []
      : [
          '--label',
          `${DOCKER_COMPOSE_PROJECT_LABEL}=${requireComposeProject(input.composeProject)}`,
        ]),
    ...(input.runtimeId === undefined
      ? []
      : ['--label', `agent-workspace.runtime-id=${input.runtimeId}`]),
    ...(input.sessionId === undefined
      ? []
      : ['--label', `agent-workspace.session-id=${input.sessionId}`]),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,size=256m',
    '--pids-limit',
    '256',
    '--memory',
    // The bind default stays the spec section 14.4 literal.
    !tmpfsWorkspace && input.memoryMb === undefined ? '1g' : `${String(memoryMb)}m`,
    '--cpus',
    String(input.cpu ?? 1),
    '--user',
    '1000:1000',
    '--network',
    network,
    ...Object.entries(input.env ?? {}).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    ...workspaceMount,
    ...(input.publish === 'loopback'
      ? [
          '--publish',
          `127.0.0.1::${DOCKER_RUNTIME_PORT}`,
          '--add-host',
          'host.docker.internal:host-gateway',
        ]
      : []),
    '--workdir',
    '/workspace',
    input.image,
    ...(input.command ?? []),
  ];
}

/** The `127.0.0.1:<port>` line `docker port` prints for a loopback-published port. */
const LOOPBACK_BINDING = /^127\.0\.0\.1:(\d{1,5})$/mu;

export function dockerRuntimeName(runtimeId: string): string {
  return `agent-workspace-${runtimeId}`;
}

/** The session's proxy container. It carries the sandbox's labels, so label-based reaping finds it. */
export function dockerEgressProxyName(runtimeId: string): string {
  return `${dockerRuntimeName(runtimeId)}-egress`;
}

/** The internal network that joins one sandbox to its proxy and to nothing else. */
export function dockerEgressNetworkName(runtimeId: string): string {
  return `aw-egress-${runtimeId}`;
}

/**
 * The proxy's own, non-internal way out. It is per session so no other container on the host can
 * reach the proxy, as it could on Docker's default `bridge`. This refines the Docker row of
 * ADR-0117 decision 7, which names the shared `agent-egress` network and "an external network".
 */
export function dockerEgressOutNetworkName(runtimeId: string): string {
  return `aw-egress-out-${runtimeId}`;
}

const DOCKER_SESSION_NETWORK_VALUE = 'docker-session-network';

/**
 * The proxy container of one session. It starts on its session's `aw-egress-out-<id>`, which is its
 * way out, and the driver then attaches it to the internal session network, which is the sandbox's
 * only way to it. It is hardened like the sandbox and writes nothing to disk.
 */
export function buildDockerEgressProxyArgs(
  input: Readonly<{
    name: string;
    image: string;
    runtimeId: string;
    sessionId: string;
    allowlist: string;
    outNetwork: string;
    composeProject?: string;
  }>,
): readonly string[] {
  return [
    'run',
    '--detach',
    '--name',
    input.name,
    '--label',
    DOCKER_SANDBOX_LABEL,
    ...(input.composeProject === undefined
      ? []
      : [
          '--label',
          `${DOCKER_COMPOSE_PROJECT_LABEL}=${requireComposeProject(input.composeProject)}`,
        ]),
    '--label',
    `agent-workspace.runtime-id=${input.runtimeId}`,
    '--label',
    `agent-workspace.session-id=${input.sessionId}`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--pids-limit',
    '128',
    '--memory',
    '256m',
    '--cpus',
    '0.5',
    '--user',
    '1000:1000',
    '--network',
    input.outNetwork,
    '--env',
    `EGRESS_SESSION_ID=${input.sessionId}`,
    '--env',
    `EGRESS_ALLOWLIST=${input.allowlist}`,
    input.image,
  ];
}

async function ensureInternalNetwork(
  docker: DockerCommand,
  networkName: string,
  composeProject: string | undefined,
): Promise<void> {
  const inspected = await docker(['network', 'inspect', networkName]);
  if (inspected.exitCode === 0) {
    validateInternalNetworkInspection(inspected, networkName);
    return;
  }
  const created = await docker([
    'network',
    'create',
    '--driver',
    'bridge',
    '--internal',
    '--label',
    `${DOCKER_NETWORK_OWNERSHIP_LABEL}=${DOCKER_NETWORK_OWNERSHIP_VALUE}`,
    ...(composeProject === undefined
      ? []
      : ['--label', `${DOCKER_COMPOSE_PROJECT_LABEL}=${composeProject}`]),
    networkName,
  ]);
  let verified: DockerCommandResult;
  if (created.exitCode !== 0) {
    // A concurrent creator may have won between inspect and create. Accept only if the network
    // can now be positively inspected and satisfies every isolation and ownership invariant.
    verified = requireSuccessful(
      await docker(['network', 'inspect', networkName]),
      `create internal network ${JSON.stringify(networkName)}`,
    );
  } else {
    // Do not trust a successful create response on its own. A daemon/plugin mismatch or a race
    // still has to produce the exact network we asked for before a container may use it.
    verified = requireSuccessful(
      await docker(['network', 'inspect', networkName]),
      `inspect newly-created internal network ${JSON.stringify(networkName)}`,
    );
  }
  validateInternalNetworkInspection(verified, networkName);
}

export function createDockerDriver<TRequest, TEvent>(
  options: DockerDriverOptions<TRequest, TEvent>,
): DockerDriver<TRequest, TEvent> {
  const images = options.images;
  if (options.requireDigest === true) assertDigestPinnedEngineImages(images, 'docker');
  const networkName = requireValue(options.networkName ?? 'agent-egress', 'networkName');
  const networkPolicy = options.networkPolicy ?? 'none';
  const docker = options.docker ?? runDockerCommand;
  const workspaceStorage = options.workspaceStorage ?? 'bind';
  const composeProject =
    options.composeProject === undefined
      ? undefined
      : requireComposeProject(options.composeProject);
  const publish = options.publish;
  const live = new Map<string, RuntimeHandle>();
  // Live handle id -> `http://127.0.0.1:<port>`, under `publish: 'loopback'` only.
  const published = new Map<string, string>();
  const proxyImage =
    options.egressProxyImage === undefined
      ? undefined
      : requireEgressProxyImage('docker', options.egressProxyImage, options.requireDigest === true);
  const proxyBypass = requireProxyBypass('docker', options.proxyBypass ?? []);
  // Handle id -> the proxy container and network a proxied session owns.
  const sessions = new Map<string, Readonly<{ proxy: string; networks: readonly string[] }>>();
  // Handles the deadline reaper removed, id -> container. The manager still holds them, so its
  // later destroy() must succeed instead of throwing "no longer live".
  const reaped = new Map<string, string>();
  // Handles whose failed reaper rm was already logged, so a stuck container warns once, not every tick.
  const reapWarned = new Set<string>();
  let reaperTimer: ReturnType<typeof setInterval> | undefined;
  let reaping = false;

  function stopReaper(): void {
    if (reaperTimer === undefined) return;
    clearInterval(reaperTimer);
    reaperTimer = undefined;
  }

  function stopReaperIfIdle(): void {
    if (![...live.values()].some((handle) => handle.expiresAt !== undefined)) stopReaper();
  }

  function startReaper(): void {
    if (reaperTimer !== undefined) return;
    reaperTimer = setInterval(() => {
      if (reaping) return;
      reaping = true;
      void reapExpired().finally(() => {
        reaping = false;
        stopReaperIfIdle();
      });
    }, DOCKER_REAP_INTERVAL_MS);
    reaperTimer.unref();
  }

  /** `rm --force --volumes` one container, repeated while another removal of it is in progress. */
  async function removeContainer(container: string): Promise<DockerCommandResult> {
    for (let attempt = 1; ; attempt += 1) {
      const result = await docker(['rm', '--force', '--volumes', container]);
      if (!DOCKER_REMOVAL_IN_PROGRESS.test(result.stderr) || attempt >= DOCKER_REMOVAL_ATTEMPTS) {
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, DOCKER_REMOVAL_RETRY_MS));
    }
  }

  /** `rm --force --volumes` each container. Never throws; an already-gone container counts as removed. */
  async function removeContainers(containers: Iterable<string>): Promise<DockerReapReport> {
    const outcomes = await Promise.all(
      [...containers].map(async (container) => ({
        container,
        result: await removeContainer(container).catch((error: unknown) => commandFailure(error)),
      })),
    );
    const removed: string[] = [];
    const failed: { container: string; reason: string }[] = [];
    for (const { container, result } of outcomes) {
      // A container that is already gone (its run ended, or `--rm` removed it first) is the
      // outcome a reap wants, not a failure that would make the shutdown read as unclean.
      if (result.exitCode === 0 || /No such container/iu.test(result.stderr)) {
        removed.push(container);
        continue;
      }
      const reason = result.stderr.trim() || `exit ${String(result.exitCode)}`;
      failed.push({ container, reason });
    }
    return { removed, failed };
  }

  /** `network rm`; a network that is already gone counts as removed. Returns the failure, if any. */
  async function removeNetwork(network: string): Promise<string | undefined> {
    const result = await docker(['network', 'rm', network]).catch((error: unknown) =>
      commandFailure(error),
    );
    if (result.exitCode === 0 || /not found|No such network/iu.test(result.stderr))
      return undefined;
    return result.stderr.trim() || `exit ${String(result.exitCode)}`;
  }

  /** `network rm` each network; returns the failures joined, if any. */
  async function removeNetworks(networks: readonly string[]): Promise<string | undefined> {
    const failures: string[] = [];
    for (const network of networks) {
      const failure = await removeNetwork(network);
      if (failure !== undefined) failures.push(`${network}: ${failure}`);
    }
    return failures.length === 0 ? undefined : failures.join('; ');
  }

  /** Create one of a session's two networks, labelled so `reapAll` finds it by project. */
  async function createSessionNetwork(
    id: string,
    network: string,
    internal: boolean,
  ): Promise<void> {
    requireSuccessful(
      await docker([
        'network',
        'create',
        '--driver',
        'bridge',
        ...(internal ? ['--internal'] : []),
        '--label',
        `${DOCKER_NETWORK_OWNERSHIP_LABEL}=${DOCKER_SESSION_NETWORK_VALUE}`,
        '--label',
        `agent-workspace.runtime-id=${id}`,
        ...(composeProject === undefined
          ? []
          : ['--label', `${DOCKER_COMPOSE_PROJECT_LABEL}=${composeProject}`]),
        network,
      ]),
      internal ? 'create egress network' : 'create egress proxy network',
    );
  }

  /** Undo a failed proxied `create`, warning about anything it could not remove. */
  async function rollbackSession(
    id: string,
    containers: readonly string[],
    networks: readonly string[],
  ): Promise<void> {
    const cleanup = await removeContainers(containers);
    const networkFailure = await removeNetworks(networks);
    if (cleanup.failed.length > 0 || networkFailure !== undefined) {
      console.warn(
        `[docker] rollback of egress session ${id} left resources behind: ${JSON.stringify({ containers: cleanup.failed, network: networkFailure })}`,
      );
    }
  }

  /** Remove a proxied session's networks once its containers are gone, and forget the session. */
  async function removeSessionNetwork(id: string): Promise<string | undefined> {
    const session = sessions.get(id);
    if (session === undefined) return undefined;
    const failure = await removeNetworks(session.networks);
    if (failure === undefined) sessions.delete(id);
    return failure;
  }

  /** Every container a handle owns: the sandbox and, when proxied, its proxy. */
  function containersOf(handle: RuntimeHandle): readonly string[] {
    const session = sessions.get(handle.id);
    return session === undefined ? [handle.externalId] : [handle.externalId, session.proxy];
  }

  async function reapExpired(): Promise<DockerReapReport> {
    const now = Date.now();
    const expired = [...live.values()].filter(
      (handle) => handle.expiresAt !== undefined && handle.expiresAt.getTime() <= now,
    );
    const report = await removeContainers(expired.flatMap(containersOf));
    for (const handle of expired) {
      const owned = containersOf(handle);
      if (!owned.every((container) => report.removed.includes(container))) {
        const failure = report.failed.find((entry) => owned.includes(entry.container));
        if (failure !== undefined && !reapWarned.has(handle.id)) {
          reapWarned.add(handle.id);
          console.warn(
            `[docker] could not remove expired sandbox ${failure.container}: ${failure.reason}`,
          );
        }
        continue;
      }
      reapWarned.delete(handle.id);
      const networkFailure = await removeSessionNetwork(handle.id);
      if (networkFailure !== undefined) {
        console.warn(
          `[docker] could not remove the egress network of expired sandbox ${handle.externalId}: ${networkFailure}`,
        );
      }
      // A concurrent destroy() may have removed and dropped this handle while the rm was awaited;
      // recording it as reaped then would leave an entry no destroy() ever clears.
      if (live.get(handle.id) !== handle) continue;
      live.delete(handle.id);
      published.delete(handle.id);
      reaped.set(handle.id, handle.externalId);
    }
    stopReaperIfIdle();
    return report;
  }

  /**
   * The sandboxes of this Compose project the daemon still has, found by both labels. A listing
   * that fails is returned as a failure, never as an empty list: reading it as "nothing left"
   * would report a shutdown that removed nothing as clean.
   */
  async function labelledSandboxes(): Promise<
    Readonly<{ ok: true; containers: readonly string[] }> | Readonly<{ ok: false; reason: string }>
  > {
    if (composeProject === undefined) return { ok: true, containers: [] };
    const listed = await docker([
      'ps',
      '--all',
      '--quiet',
      '--no-trunc',
      '--filter',
      `label=${DOCKER_SANDBOX_LABEL}`,
      '--filter',
      `label=${DOCKER_COMPOSE_PROJECT_LABEL}=${composeProject}`,
    ]).catch((error: unknown) => commandFailure(error));
    if (listed.exitCode !== 0) {
      return { ok: false, reason: listed.stderr.trim() || `exit ${String(listed.exitCode)}` };
    }
    return {
      ok: true,
      containers: listed.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    };
  }

  /** Read where `docker run --publish 127.0.0.1::8080` put the port; remove the sandbox if unreadable. */
  async function publishedLoopbackOrigin(externalId: string): Promise<string> {
    const port = await docker(['port', externalId, DOCKER_RUNTIME_PORT]).catch((error: unknown) =>
      commandFailure(error),
    );
    const match = port.exitCode === 0 ? LOOPBACK_BINDING.exec(port.stdout) : null;
    if (match?.[1] !== undefined) return `http://127.0.0.1:${match[1]}`;
    await docker(['rm', '--force', '--volumes', externalId]).catch(() => undefined);
    const detail = port.stderr.trim() || port.stdout.trim() || `exit ${String(port.exitCode)}`;
    throw new Error(`docker runtime: read the published runtime port failed: ${detail}`);
  }

  function assertLive(runtime: RuntimeHandle, operation: string): RuntimeHandle {
    const known = live.get(runtime.id);
    if (known === undefined || known.externalId !== runtime.externalId) {
      throw new Error(
        `docker runtime: cannot ${operation}; handle ${JSON.stringify(runtime.id)} was not created by this driver or is no longer live.`,
      );
    }
    return known;
  }

  return {
    id: 'docker',
    capabilities:
      proxyImage === undefined ? DOCKER_RUNTIME_CAPABILITIES : DOCKER_PROXIED_RUNTIME_CAPABILITIES,

    async create(config: RuntimeConfig): Promise<RuntimeHandle> {
      requireValue(config.sessionId, 'sessionId');
      const workspacePath = requireValue(config.workspacePath, 'workspacePath');
      // ENG-07's dispatch invariant, at the one place that can hold it: the image is chosen from
      // the run's engine, before anything is created, so a run can only ever start in the image
      // this deployment declared for its engine.
      const image = requireEngineImage(images, requireValue(config.engine, 'engine'), 'docker');
      const spec = config.runSpec;
      if (spec !== undefined && spec.driver !== 'docker') {
        throw new Error(`docker runtime: run spec selects incompatible driver ${spec.driver}.`);
      }
      const selectedNetworkPolicy = spec?.networkPolicy ?? networkPolicy;
      const allowlist = resolveEgressAllowlist(
        proxyImage,
        selectedNetworkPolicy,
        spec?.allowedDomains,
      );
      requireDiskMb(spec?.diskMb, workspaceStorage);
      if (spec?.cpu !== undefined && (!Number.isFinite(spec.cpu) || spec.cpu <= 0)) {
        throw new Error('docker runtime: cpu must be a positive finite number.');
      }
      if (
        spec?.memoryMb !== undefined &&
        (!Number.isSafeInteger(spec.memoryMb) || spec.memoryMb < 64)
      ) {
        throw new Error('docker runtime: memoryMb must be a safe integer of at least 64.');
      }
      if (workspaceStorage === 'bind') {
        await mkdir(workspacePath, { recursive: true });
        // The container is deliberately uid/gid 1000 rather than the host process's identity.
        // A freshly-created host directory is otherwise commonly 0700 and unusable through the
        // bind mount. The object-store hydration boundary contains the session's data; this grants
        // the container access to that one directory, not to a parent or an operator path.
        await chmod(workspacePath, 0o777);
      }
      const proxied = proxyImage !== undefined && allowlist !== null;
      // A proxied `open` sandbox is on the internal network like any other: its way out is the proxy.
      const sandboxPolicy: DockerNetworkPolicy = proxied ? 'restricted' : selectedNetworkPolicy;
      if (publish === 'loopback' && sandboxPolicy !== 'open') {
        throw new Error(
          'docker runtime: a sandbox published on the host loopback needs network policy open; an internal network publishes no port.',
        );
      }
      if (sandboxPolicy !== 'open') {
        await ensureInternalNetwork(docker, networkName, composeProject);
      }

      const id = randomUUID();
      const name = dockerRuntimeName(id);
      const runArgs = (env?: Readonly<Record<string, string>>): readonly string[] =>
        buildDockerRunArgs({
          name,
          image,
          workspacePath,
          workspaceStorage,
          networkPolicy: sandboxPolicy,
          networkName,
          runtimeId: id,
          sessionId: config.sessionId,
          ...(composeProject === undefined ? {} : { composeProject }),
          ...(spec?.cpu === undefined ? {} : { cpu: spec.cpu }),
          ...(spec?.memoryMb === undefined ? {} : { memoryMb: spec.memoryMb }),
          ...(spec?.diskMb === undefined ? {} : { workspaceMb: spec.diskMb }),
          ...(spec?.filesystem === undefined ? {} : { filesystem: spec.filesystem }),
          ...(options.command === undefined ? {} : { command: options.command }),
          ...(env === undefined ? {} : { env }),
          ...(publish === undefined ? {} : { publish }),
        });
      let externalId: string;
      let session: Readonly<{ proxy: string; networks: readonly string[] }> | undefined;
      if (proxied) {
        const network = dockerEgressNetworkName(id);
        const outNetwork = dockerEgressOutNetworkName(id);
        session = { proxy: dockerEgressProxyName(id), networks: [network, outNetwork] };
        const created: string[] = [];
        try {
          await createSessionNetwork(id, network, true);
          await createSessionNetwork(id, outNetwork, false);
          created.push(session.proxy);
          requireSuccessful(
            await docker(
              buildDockerEgressProxyArgs({
                name: session.proxy,
                image: proxyImage,
                runtimeId: id,
                sessionId: config.sessionId,
                allowlist,
                outNetwork,
                ...(composeProject === undefined ? {} : { composeProject }),
              }),
            ),
            'start egress proxy',
          );
          requireSuccessful(
            await docker(['network', 'connect', network, session.proxy]),
            'attach egress proxy to its network',
          );
          created.push(name);
          const result = requireSuccessful(
            await docker(
              runArgs(
                egressProxyEnvironment(
                  `http://${session.proxy}:${String(EGRESS_PROXY_PORT)}`,
                  proxyBypass,
                ),
              ),
            ),
            'start container',
          );
          externalId = requireValue(result.stdout.trim(), 'container id returned by docker');
          requireSuccessful(
            await docker(['network', 'connect', network, name]),
            'attach sandbox to the egress network',
          );
        } catch (error) {
          await rollbackSession(id, created, session.networks);
          throw error;
        }
      } else {
        const result = requireSuccessful(await docker(runArgs()), 'start container');
        externalId = requireValue(result.stdout.trim(), 'container id returned by docker');
        if (publish === 'loopback') {
          published.set(id, await publishedLoopbackOrigin(externalId));
        }
      }
      const handle: RuntimeHandle = {
        id,
        driver: 'docker',
        externalId,
        workspacePath,
        createdAt: new Date(),
        ...(spec?.timeoutSeconds === undefined
          ? {}
          : { expiresAt: new Date(Date.now() + spec.timeoutSeconds * 1_000) }),
      };
      live.set(id, handle);
      if (session !== undefined) sessions.set(id, session);
      if (handle.expiresAt !== undefined) startReaper();
      return handle;
    },

    async startAgent(runtime, request) {
      return await options.startAgent(assertLive(runtime, 'start an agent'), request);
    },

    async destroy(runtime) {
      if (reaped.get(runtime.id) === runtime.externalId) {
        reaped.delete(runtime.id);
        // The reaper already removed the containers; a network it could not remove is retried here.
        await removeSessionNetwork(runtime.id);
        return;
      }
      const known = assertLive(runtime, 'destroy');
      const result = await removeContainer(known.externalId);
      // A reaper tick racing this call may have removed the container first; it is gone either way.
      if (!/No such container/iu.test(result.stderr)) requireSuccessful(result, 'remove container');
      const session = sessions.get(known.id);
      if (session !== undefined) {
        const proxy = await removeContainer(session.proxy);
        if (!/No such container/iu.test(proxy.stderr))
          requireSuccessful(proxy, 'remove egress proxy');
        const networkFailure = await removeSessionNetwork(known.id);
        if (networkFailure !== undefined) {
          throw new Error(`docker runtime: remove egress network failed: ${networkFailure}`);
        }
      }
      live.delete(known.id);
      published.delete(known.id);
      reaped.delete(known.id);
      reapWarned.delete(known.id);
      stopReaperIfIdle();
    },

    async isLive(runtime) {
      const known = live.get(runtime.id);
      if (known === undefined || known.externalId !== runtime.externalId) return false;
      const result = await docker(['inspect', '--format', '{{.State.Running}}', known.externalId]);
      return result.exitCode === 0 && result.stdout.trim() === 'true';
    },

    async reapAll() {
      stopReaper();
      const held = [...live.values()];
      const containers = new Set(held.flatMap(containersOf));
      const labelled = await labelledSandboxes();
      if (labelled.ok) for (const container of labelled.containers) containers.add(container);
      const { removed, failed: removalFailures } = await removeContainers(containers);
      const failed = [...removalFailures];
      for (const [id, session] of [...sessions]) {
        const failure = await removeSessionNetwork(id);
        if (failure !== undefined)
          failed.push({ container: `network ${session.networks.join(', ')}`, reason: failure });
      }
      if (proxyImage !== undefined && composeProject !== undefined) {
        // A session network whose process died before it was recorded here is found by its labels.
        const listed = await docker([
          'network',
          'ls',
          '--quiet',
          '--filter',
          `label=${DOCKER_NETWORK_OWNERSHIP_LABEL}=${DOCKER_SESSION_NETWORK_VALUE}`,
          '--filter',
          `label=${DOCKER_COMPOSE_PROJECT_LABEL}=${composeProject}`,
        ]).catch((error: unknown) => commandFailure(error));
        if (listed.exitCode !== 0) {
          failed.push({
            container: `network label=${DOCKER_COMPOSE_PROJECT_LABEL}=${composeProject}`,
            reason: `could not list the project's egress networks: ${listed.stderr.trim() || `exit ${String(listed.exitCode)}`}`,
          });
        }
        for (const network of listed.stdout
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean)) {
          const failure = await removeNetwork(network);
          if (failure !== undefined)
            failed.push({ container: `network ${network}`, reason: failure });
        }
      }
      if (!labelled.ok) {
        failed.push({
          container: `label=${DOCKER_COMPOSE_PROJECT_LABEL}=${composeProject ?? ''}`,
          reason: `could not list the project's sandboxes: ${labelled.reason}`,
        });
      }
      for (const handle of held) {
        if (!removed.includes(handle.externalId)) continue;
        live.delete(handle.id);
        published.delete(handle.id);
      }
      return { removed, failed };
    },

    reapExpired,

    async writeFile(runtime, name, content) {
      if (!WORKSPACE_FILE_NAME.test(name)) {
        throw new Error(`docker runtime: ${JSON.stringify(name)} is not a plain file name.`);
      }
      const known = assertLive(runtime, 'write a file');
      requireSuccessful(
        await docker(
          [
            'exec',
            '--interactive',
            known.externalId,
            'sh',
            '-c',
            'cat > "/workspace/.$0.tmp" && mv "/workspace/.$0.tmp" "/workspace/$0"',
            name,
          ],
          { input: content },
        ),
        `write ${name} into the sandbox`,
      );
    },

    publishedOrigin(runtime) {
      const origin = published.get(assertLive(runtime, 'address a sandbox').id);
      if (origin === undefined) {
        throw new Error('docker runtime: this driver does not publish its sandboxes on the host.');
      }
      return origin;
    },
  };
}
