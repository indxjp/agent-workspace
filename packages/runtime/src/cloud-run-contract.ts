import type {
  AgentConnection,
  RuntimeCapabilities,
  RuntimeConfig,
  RuntimeDriver,
  RuntimeHandle,
} from './driver.js';
import type { EngineImageMap } from './engine-images.js';

export type CloudRunRuntimeCapabilities = RuntimeCapabilities &
  Readonly<{ managedByProvider: true }>;

export type CloudRunServiceSpec = Readonly<{
  serviceId: string;
  image: string;
  region: string;
  project: string;
  serviceAccount: string;
  network: string;
  subnetwork: string;
  cpu?: number;
  memoryMb?: number;
  timeoutSeconds?: number;
  /** Warm instances kept running; 0 by default. A tool sandbox keeps its files in memory, so it needs 1. */
  minInstances?: number;
  /** Container environment; sent only when non-empty. May carry a credential: never log it. */
  env?: Readonly<Record<string, string>>;
  /** Requests one instance serves at once; 1 by default. A tool host is built for many. */
  maxRequestConcurrency?: number;
  labels: Readonly<Record<string, string>>;
}>;

export type CloudRunServiceStatus = Readonly<{
  name: string;
  url: string;
  ready: boolean;
  /** Present on a read of an existing service. */
  labels?: Readonly<Record<string, string>>;
  /** The `AW_TOOL_INTAKE_KEY` of the service's container, so another manager can write to it. */
  intakeKey?: string;
}>;

export interface CloudRunResourceClient {
  createService(spec: CloudRunServiceSpec): Promise<CloudRunServiceStatus>;
  getService(name: string): Promise<CloudRunServiceStatus | null>;
  deleteService(name: string): Promise<void>;
  /** Every service in the project and region, whoever created it. */
  listServices(project: string, region: string): Promise<readonly CloudRunServiceStatus[]>;
}

export type CloudRunAgentStarter<TRequest, TEvent> = (
  runtime: RuntimeHandle,
  request: TRequest,
) => AgentConnection<TEvent> | Promise<AgentConnection<TEvent>>;

export type CloudRunDriverOptions<TRequest, TEvent> = Readonly<{
  /** ENG-07: one image per engine; the service is deployed from the one for `config.engine`. */
  images: EngineImageMap;
  project: string;
  region: string;
  serviceAccount: string;
  startAgent: CloudRunAgentStarter<TRequest, TEvent>;
  /** VPC network and subnetwork every sandbox joins; the firewall on that network denies egress. */
  network: string;
  subnetwork: string;
  client?: CloudRunResourceClient;
  /** Production managers set this so mutable tags cannot cross the runtime boundary. */
  requireDigest?: boolean;
  pollIntervalMs?: number;
  readyTimeoutMs?: number;
  /**
   * The shared egress proxy (ADR-0117) that lets `restricted` and `open` runs reach the internet.
   * `key` signs the per-session credential; `bypass` hosts (the gateway) skip the proxy.
   */
  egressProxy?: Readonly<{ url: string; key: string; bypass: readonly string[] }>;
  /** Milliseconds since the epoch; injected by tests. */
  now?: () => number;
  /**
   * Prefix of every service id this driver creates. Must start with `rt-` so the runner manager's
   * IAM condition still covers it. The tool driver uses `rt-tool-`.
   */
  serviceIdPrefix?: string;
  /**
   * Makes `writeFile` work (ADR-0118 TS4): each service gets a random intake key in
   * `AW_TOOL_INTAKE_KEY`, and files are PUT to the service with that key and a Google ID token.
   */
  fileIntake?: Readonly<{ identityToken: (audience: string) => Promise<string> }>;
}>;

export type CloudRunDriver<TRequest, TEvent> = RuntimeDriver<TRequest, TEvent> &
  Readonly<{
    capabilities: CloudRunRuntimeCapabilities;
    isLive(runtime: RuntimeHandle): Promise<boolean>;
    /** `tags` become hashed labels, so `find` and `destroyTagged` work from any manager instance. */
    create(
      config: RuntimeConfig,
      credential?: string,
      tags?: Readonly<Record<string, string>>,
    ): Promise<RuntimeHandle>;
    /** Refuses unless the driver was built with `fileIntake`. Never echoes the key or a body. */
    writeFile(runtime: RuntimeHandle, name: string, content: string): Promise<void>;
  }>;

/**
 * A driver built with `fileIntake` (the tool-sandbox driver). Only it finds and removes services by
 * label: the runner manager prefers a driver's `find` over its own table, so an agent driver with a
 * `find` that never finds would start a new service for every follow-up run of a session.
 */
export type CloudRunToolDriver<TRequest, TEvent> = CloudRunDriver<TRequest, TEvent> &
  Readonly<{
    /** The ready service created for `config.runtimeProfileId`, or `undefined`. */
    find(config: RuntimeConfig): Promise<RuntimeHandle | undefined>;
    /** Deletes every service of this driver's prefix labelled with all of `tags`. */
    destroyTagged(tags: Readonly<Record<string, string>>): Promise<void>;
  }>;

/** Cloud Run service timeout in seconds when a run does not supply one. */
export const DEFAULT_SERVICE_TIMEOUT_SECONDS = 3600;
