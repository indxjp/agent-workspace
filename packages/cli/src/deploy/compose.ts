/**
 * `deploy` for a `local` profile: Docker Compose (ADR-0094).
 *
 * The plan never prints `docker compose config`: that output is the Compose file with `.env`
 * interpolated, credentials included. It compares, per service, the configuration hash Compose
 * would give the container now (`config --hash`) with the `com.docker.compose.config-hash` label
 * of the container that is running — the same comparison `up` makes to decide what to recreate.
 */
import { runStep, type DeployContext, type DeployOutcome } from './steps.ts';

export type ComposeServiceChange = 'create' | 'recreate' | 'start' | 'unchanged';

/** One container of the project, as `docker ps` lists it. */
export interface ComposeContainer {
  readonly service: string;
  readonly configHash: string;
  readonly running: boolean;
}

/** `docker compose config --hash '*'`: one `service hash` line per service. */
export function parseServiceHashes(stdout: string): ReadonlyMap<string, string> {
  const hashes = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const [service, hash] = line.trim().split(/\s+/u);
    if (service !== undefined && service !== '' && hash !== undefined) hashes.set(service, hash);
  }
  return hashes;
}

const CONTAINER_FORMAT =
  '{{.Label "com.docker.compose.service"}}\t{{.Label "com.docker.compose.config-hash"}}\t{{.State}}';

export function parseContainers(stdout: string): readonly ComposeContainer[] {
  return stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [service = '', configHash = '', state = ''] = line.split('\t');
      return { service, configHash, running: state.trim() === 'running' };
    });
}

/**
 * What `up` would do to each service. A service with no container is created; one whose
 * container carries another configuration hash is recreated; a matching one that is not running
 * is started. Anything unexpected reads as a change, so an unreadable state asks for `--yes`
 * rather than reporting a deployment as current.
 */
export function compareComposeServices(
  desired: ReadonlyMap<string, string>,
  containers: readonly ComposeContainer[],
): readonly (readonly [string, ComposeServiceChange])[] {
  return [...desired].map(([service, hash]) => {
    const own = containers.filter((container) => container.service === service);
    if (own.length === 0) return [service, 'create'];
    if (own.some((container) => container.configHash !== hash)) return [service, 'recreate'];
    if (own.some((container) => !container.running)) return [service, 'start'];
    return [service, 'unchanged'];
  });
}

/**
 * `project` is `.env`'s `COMPOSE_PROJECT_NAME`. Compose prefers a shell-level value over `.env`,
 * so every call runs with `.env`'s set explicitly: the hashes, the containers listed and the
 * project `up` acts on are then always the same one.
 */
export async function deployWithCompose(
  deployContext: DeployContext,
  project: string,
  apply: boolean,
): Promise<DeployOutcome> {
  const context: DeployContext = {
    ...deployContext,
    env: { ...deployContext.env, COMPOSE_PROJECT_NAME: project },
  };
  await runStep(context, 'docker', ['compose', 'config', '--quiet'], { show: true });
  const hashes = await runStep(context, 'docker', ['compose', 'config', '--hash', '*'], {
    show: false,
  });
  const listed = await runStep(
    context,
    'docker',
    [
      'ps',
      '--all',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--filter',
      'label=com.docker.compose.oneoff=False',
      '--format',
      CONTAINER_FORMAT,
    ],
    { show: false },
  );
  const desired = parseServiceHashes(hashes.stdout);
  if (desired.size === 0) {
    throw new Error('docker compose config --hash listed no service; nothing can be planned.');
  }
  const services = compareComposeServices(desired, parseContainers(listed.stdout));
  const width = Math.max(...services.map(([service]) => service.length));
  context.out(
    services.map(([service, change]) => `  ${service.padEnd(width)}  ${change}\n`).join(''),
  );

  const changes = services.some(([, change]) => change !== 'unchanged');
  if (!apply || !changes) return { changes, applied: false };
  await runStep(context, 'docker', ['compose', 'up', '--detach'], { show: true });
  return { changes, applied: true };
}
