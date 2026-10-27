import { currentWebRuntimeRegistry, type RuntimeRegistryEntry } from '../runtimes/registry';
import { defineSlot } from '../runtime-slot';

/** One driver the first-run wizard offers, as `GET /api/setup/runtime-detect` reports it. */
type DetectedRuntimeDriver = Readonly<{
  id: 'local' | 'docker';
  available: boolean;
  reason: string;
}>;

type RuntimeDetection = Readonly<{
  defaultDriver: DetectedRuntimeDriver['id'];
  drivers: readonly DetectedRuntimeDriver[];
}>;

export type RuntimeDetectionInputs = Readonly<{
  /**
   * The runner manager this deployment runs on the `docker` driver, as a liveness check, or
   * `null` when its runtime is anything else. The composition root installs it: it is the one
   * place that knows whether a runner-manager client was created and which driver it runs.
   */
  dockerManager: Readonly<{ probe(): Promise<boolean> }> | null;
}>;

const LOCAL_REASON = 'Runs in the runner process without tenant isolation.';
const DOCKER_REASON = 'Runs each session in its own container through the runner manager.';
const DOCKER_NOT_CONFIGURED =
  'This deployment has no runner manager configured with the docker driver.';
const DOCKER_UNREACHABLE =
  'The runner manager did not answer its health check. Start it, wait a few seconds and reload this page.';
const LOCAL_DEVELOPMENT_ONLY =
  'The local driver is for development only and is not offered in a production deployment.';
const REGISTRY_UNAVAILABLE = 'Runtime detection is unavailable.';

/**
 * What the first-run wizard may offer, derived from the deployment rather than a constant.
 *
 * The default is the topology's own driver: a deployment whose runtime is a runner manager on the
 * `docker` driver (the Docker Compose topology) defaults to `docker`, and every other deployment
 * keeps defaulting to `local`. Availability is stricter than the default: `docker` is available
 * only when the installed registry enables it **and** the runner manager answers its health
 * check, so an unreachable manager is reported as unavailable instead of being claimed. `local`
 * mirrors the registry's own answer, which is what `POST /api/setup` will accept.
 */
async function detectSetupRuntimes(inputs: RuntimeDetectionInputs): Promise<RuntimeDetection> {
  // The installed driver registry — the same one `POST /api/setup` accepts a driver from.
  const registry = currentWebRuntimeRegistry();
  const entries = registry === null ? [] : await registry.list();
  const entryFor = (id: string) => entries.find((entry) => entry.id === id);

  const localEntry = entryFor('local');
  const local: DetectedRuntimeDriver =
    localEntry?.state === 'enabled'
      ? { id: 'local', available: true, reason: LOCAL_REASON }
      : {
          id: 'local',
          available: false,
          // The registry disables `local` for one reason only — a production process — so its
          // generic "no connection / image not reachable" text would send an operator looking for
          // configuration that does not exist.
          reason: localEntry === undefined ? REGISTRY_UNAVAILABLE : LOCAL_DEVELOPMENT_ONLY,
        };

  const docker = await detectDocker(inputs, entryFor('docker'));
  return {
    defaultDriver: inputs.dockerManager === null ? 'local' : 'docker',
    drivers: [local, docker],
  };
}

async function detectDocker(
  inputs: RuntimeDetectionInputs,
  entry: RuntimeRegistryEntry | undefined,
): Promise<DetectedRuntimeDriver> {
  if (inputs.dockerManager === null) {
    return { id: 'docker', available: false, reason: DOCKER_NOT_CONFIGURED };
  }
  if (entry === undefined || entry.state !== 'enabled') {
    return {
      id: 'docker',
      available: false,
      reason: entry?.reason ?? REGISTRY_UNAVAILABLE,
    };
  }
  const reachable = await inputs.dockerManager.probe().catch(() => false);
  return reachable
    ? { id: 'docker', available: true, reason: DOCKER_REASON }
    : { id: 'docker', available: false, reason: DOCKER_UNREACHABLE };
}

/** How long one detection answer is reused, so anonymous traffic cannot fan out into probes. */
const DETECTION_TTL_MS = 5_000;

type DetectionSlot = {
  inputs: RuntimeDetectionInputs;
  cached: { expiresAt: number; result: Promise<RuntimeDetection> } | null;
};

const slot = defineSlot<DetectionSlot>('__agentWorkspaceSetupRuntimeDetection__');

/**
 * The inputs for a deployment whose runner manager (if any) runs `managedDriverId`. Only a runner
 * manager that exists and runs `docker` — the Docker Compose topology — makes `docker` the
 * default; every other deployment, including one whose manager runs another driver, keeps `local`.
 */
export function setupRuntimeDetectionInputs(
  runnerManagerUrl: string | null,
  managedDriverId: string,
  probe: (runnerManagerUrl: string) => Promise<boolean>,
): RuntimeDetectionInputs {
  return {
    dockerManager:
      runnerManagerUrl !== null && managedDriverId === 'docker'
        ? { probe: () => probe(runnerManagerUrl) }
        : null,
  };
}

/** Installed by the composition root once it knows this deployment's runner manager. */
export function configureSetupRuntimeDetection(inputs: RuntimeDetectionInputs): void {
  slot.set({ inputs, cached: null });
}

export function clearSetupRuntimeDetection(): void {
  slot.clear();
}

/**
 * This process's detection, reused for {@link DETECTION_TTL_MS}. `GET /api/setup/runtime-detect`
 * is public, so without the cache every anonymous request would become a runner-manager health
 * check; concurrent requests share one in-flight answer. Before the composition has installed its
 * inputs, the answer is the registry's alone with no runner manager — the local default.
 */
export function currentSetupRuntimeDetection(now: number = Date.now()): Promise<RuntimeDetection> {
  const detection = slot.current();
  if (detection === null) {
    return detectSetupRuntimes({ dockerManager: null });
  }
  if (detection.cached !== null && detection.cached.expiresAt > now) return detection.cached.result;
  const result = detectSetupRuntimes(detection.inputs);
  const cached = { expiresAt: now + DETECTION_TTL_MS, result };
  detection.cached = cached;
  // A failed detection is not an answer worth repeating for the next five seconds.
  void result.catch(() => {
    if (detection.cached === cached) detection.cached = null;
  });
  return result;
}
