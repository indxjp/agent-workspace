import { commandFailure, requireSuccessful } from './command.js';
import {
  type DockerCommandResult,
  type DockerReapReport,
  DOCKER_COMPOSE_PROJECT_LABEL,
  DOCKER_NETWORK_OWNERSHIP_LABEL,
  DOCKER_SANDBOX_LABEL,
  DOCKER_SESSION_NETWORK_VALUE,
} from './model.js';
import type { RuntimeHandle } from '../driver.js';

import type { DockerState } from './state.js';
export function createDockerRemoval(state: DockerState) {
  const { docker, composeProject, sessions } = state;
  /**
   * Docker's answer to an `rm` of a container another call (a reaper tick, `destroy`) is still
   * removing. That removal may yet fail, so the `rm` is repeated until it settles.
   */
  const DOCKER_REMOVAL_IN_PROGRESS = /removal of container \S+ is already in progress/iu;

  const DOCKER_REMOVAL_ATTEMPTS = 50;

  const DOCKER_REMOVAL_RETRY_MS = 200;
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
  return {
    removeContainer,
    removeContainers,
    removeNetwork,
    removeNetworks,
    createSessionNetwork,
    rollbackSession,
    removeSessionNetwork,
    containersOf,
    labelledSandboxes,
  };
}
export type DockerRemoval = ReturnType<typeof createDockerRemoval>;
