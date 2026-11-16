import { commandFailure, requireSuccessful } from './command.js';
import type { DockerDriver } from './model.js';
import {
  type DockerReapReport,
  DOCKER_COMPOSE_PROJECT_LABEL,
  DOCKER_NETWORK_OWNERSHIP_LABEL,
  DOCKER_REAP_INTERVAL_MS,
  DOCKER_SESSION_NETWORK_VALUE,
} from './model.js';
import type { RuntimeHandle } from '../driver.js';

import type { DockerRemoval } from './removal.js';
import type { DockerState } from './state.js';
export function createDockerLifecycle(state: DockerState, removal: DockerRemoval) {
  const { composeProject, live, published, sessions, reaped, reapWarned } = state;
  const {
    removeContainer,
    removeContainers,
    removeSessionNetwork,
    containersOf,
    labelledSandboxes,
  } = removal;
  function assertLive(runtime: RuntimeHandle, operation: string): RuntimeHandle {
    const known = live.get(runtime.id);
    if (known === undefined || known.externalId !== runtime.externalId) {
      throw new Error(
        `docker runtime: cannot ${operation}; handle ${JSON.stringify(runtime.id)} was not created by this driver or is no longer live.`,
      );
    }
    return known;
  }
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
  const methods: Pick<DockerDriver<never, never>, 'destroy' | 'reapAll' | 'reapExpired'> = {
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
      failed.push(...(await removeProjectNetworks(state, removal)));
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
  };
  return { ...methods, assertLive, startReaper };
}
export type DockerLifecycle = ReturnType<typeof createDockerLifecycle>;
async function removeProjectNetworks(
  state: DockerState,
  removal: DockerRemoval,
): Promise<{ container: string; reason: string }[]> {
  const { docker, proxyImage, composeProject } = state;
  const { removeNetwork } = removal;
  const failed: { container: string; reason: string }[] = [];
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
      if (failure !== undefined) failed.push({ container: `network ${network}`, reason: failure });
    }
  }

  return failed;
}
