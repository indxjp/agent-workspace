import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DOCKER_COMMAND_TIMEOUT_MS,
  type DockerCommand,
  type DockerContextInspector,
  dockerEndpoint,
  runDocker,
} from './deployment-docker.ts';
import { parseEnvironment, validateDeploymentEnvironment } from './deployment-environment.ts';
import {
  assertWebPortFree,
  describeHostPortInUse,
  HOST_PORT_IN_USE,
  hostPortFree,
  type HostPortProbe,
  type OwnProject,
  realPathOrResolved,
  webUrl,
} from './deployment-ports.ts';
import { applyDaemonSocketGroupId, assertRunnerCanUseSocket } from './deployment-socket.ts';

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

export type { DeploymentImages } from './deployment-images.ts';

export { assertDigestReference } from './deployment-images.ts';

export { assertDigestReferences } from './deployment-images.ts';

export { resolveDeploymentImages } from './deployment-images.ts';

export { resolveEgressProxyImage } from './deployment-images.ts';

export { resolveToolHostImage } from './deployment-images.ts';

export { parseEnvLine } from './deployment-environment.ts';

export { parseEnvironment } from './deployment-environment.ts';

export { CLAUDE_AGENT_SDK_RUNTIME_IMAGE_KEY } from './deployment-environment.ts';

export { assertComposeProjectName } from './deployment-environment.ts';

export { validateDeploymentEnvironment } from './deployment-environment.ts';

export type { DockerCommand } from './deployment-docker.ts';

export { runDocker } from './deployment-docker.ts';

export type { DockerContextInspector } from './deployment-docker.ts';

export { DOCKER_CONTEXT_INSPECT_TIMEOUT_MS } from './deployment-docker.ts';

export { dockerEndpoint } from './deployment-docker.ts';

export { dockerSocketGroupId } from './deployment-docker.ts';

export { DOCKER_SOCKET_GROUP_PROBE_TIMEOUT_MS } from './deployment-socket.ts';

export { daemonSocketGroupId } from './deployment-socket.ts';

export { RUNNER_SOCKET_PING } from './deployment-socket.ts';

export type { HostPortProbe } from './deployment-ports.ts';

export { hostPortFree } from './deployment-ports.ts';

export { webUrl } from './deployment-ports.ts';
