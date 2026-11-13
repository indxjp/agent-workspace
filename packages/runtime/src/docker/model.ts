import type {
  AgentConnection,
  RuntimeCapabilities,
  RuntimeDriver,
  RuntimeHandle,
} from '../driver.js';
import type { EngineImageMap } from '../engine-images.js';
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

/** The port the runtime image serves the section 14.3 contract on. */
export const DOCKER_RUNTIME_PORT = '8080/tcp';

/** The `/workspace` tmpfs size when the run spec sets no `diskMb`. */
export const DOCKER_DEFAULT_WORKSPACE_MB = 1_024;

export const DOCKER_NETWORK_OWNERSHIP_LABEL = 'agent-workspace.runtime';

export const DOCKER_NETWORK_OWNERSHIP_VALUE = 'docker-network';

/** The label every sandbox this driver starts carries; `agent-workspace stop` filters on it. */
export const DOCKER_SANDBOX_LABEL = 'agent-workspace.runtime=docker';

/**
 * The label naming the Compose project a sandbox belongs to (issue #394). Deliberately not
 * Compose's own `com.docker.compose.project`: a container carrying that label but no
 * `com.docker.compose.service` is an orphan to Compose, which `up --remove-orphans` would remove
 * mid-run and other Compose commands warn about.
 */
export const DOCKER_COMPOSE_PROJECT_LABEL = 'agent-workspace.compose-project';

export const DOCKER_SESSION_NETWORK_VALUE = 'docker-session-network';
