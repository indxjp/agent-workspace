import {
  type DockerNetworkPolicy,
  DOCKER_COMPOSE_PROJECT_LABEL,
  DOCKER_DEFAULT_WORKSPACE_MB,
  DOCKER_RUNTIME_PORT,
  DOCKER_SANDBOX_LABEL,
} from './model.js';
import { requireComposeProject } from './network.js';
import { egressAllowlist } from '../egress.js';
import { RuntimeRefusalError } from '../external/errors.js';
/** The agent's `--memory` budget when the run spec sets no `memoryMb`. */
const DOCKER_DEFAULT_MEMORY_MB = 1_024;

const DOCKER_MIN_WORKSPACE_MB = 16;

// Refuses the policies a deployment without an egress proxy cannot enforce, then resolves the
// proxy allowlist. null: no proxy (policy `none`, `restricted` with nothing allowed, or no proxy image).
// A refusal is `network_policy_unsupported`, so the runner manager answers 422 with that code
// rather than a nameless 500 (BH061-030).
export function resolveEgressAllowlist(
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

export function requireDiskMb(
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

/**
 * Generate the complete `docker run` vector. The security defaults are the fenced command in
 * spec section 14.4. `anonymous-volume` mounts `/workspace` as a tmpfs of `workspaceMb` (the
 * daemon-owned volume it replaces was deleted with the container anyway); `bind` mounts a host
 * path, which Docker cannot size. `none` deliberately means the internal `agent-egress` network, not Docker's
 * all-or-nothing `--network none`: the gateway must remain reachable.
 */
type DockerRunInput = Readonly<{
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
}>;

export function buildDockerRunArgs(input: DockerRunInput): readonly string[] {
  const tmpfsWorkspace = input.workspaceStorage === 'anonymous-volume';
  const workspaceMb = input.workspaceMb ?? DOCKER_DEFAULT_WORKSPACE_MB;
  // tmpfs pages are charged to the memory cgroup, so the container's --memory covers the agent's
  // memory plus its tmpfs workspace: the agent keeps its full budget and a full workspace hits
  // ENOSPC instead of an OOM kill.
  const memoryMb =
    (input.memoryMb ?? DOCKER_DEFAULT_MEMORY_MB) + (tmpfsWorkspace ? workspaceMb : 0);
  const workspaceMount = workspaceMountArguments(input);
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
function workspaceMountArguments(input: DockerRunInput): readonly string[] {
  const tmpfsWorkspace = input.workspaceStorage === 'anonymous-volume';
  const workspaceMb = input.workspaceMb ?? DOCKER_DEFAULT_WORKSPACE_MB;
  const readOnly = input.filesystem === 'read-only';
  return tmpfsWorkspace
    ? [
        '--tmpfs',
        `/workspace:${readOnly ? 'ro' : 'rw'},exec,nosuid,nodev,size=${String(workspaceMb)}m,uid=1000,gid=1000,mode=0700`,
      ]
    : [
        '--mount',
        `type=bind,src=${input.workspacePath},dst=/workspace${readOnly ? ',readonly' : ''}`,
      ];
}
