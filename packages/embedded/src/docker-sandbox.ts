/**
 * `aw dev --sandbox docker` (#786): the runner manager the embedded workspace starts when
 * `RUNTIME_DRIVER` is `docker`, so every run of the session executes in a container started by
 * `packages/runtime/src/docker.ts`, never in this process.
 *
 * It is `apps/runner`'s own manager (`startRunnerManager`) on the docker driver, bound to loopback
 * on a port the OS picks, with each sandbox's runtime port published on `127.0.0.1` because this
 * process is not on the sandboxes' network. Before the web starts, the manager runs its own
 * create/readiness/echo/destroy verification once: a session that says docker but cannot start a
 * container fails here, with one message, instead of failing every run later.
 *
 * The manager is configured from an allowlist, never from this process's environment, and the
 * driver passes no environment into a container: a run's gateway URL and token reach the sandbox
 * in its run request, as in every other deployment.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isIPv4 } from 'node:net';
import path from 'node:path';

import { startRunnerManager } from '@agent-workspace/runner/manager-start';
import { runDockerCommand, type DockerCommand } from '@agent-workspace/runtime';

/** The tag `compose.yaml` builds from `runtime.Dockerfile`, as the runner manager defaults to. */
export const DEFAULT_DOCKER_RUNTIME_IMAGE = 'agent-workspace/runtime:dev';

const IMAGE_VARIABLE = /^(?:RUNTIME_IMAGE|AGENT_WORKSPACE_RUNTIME_IMAGE_[A-Z0-9_]+)$/u;

const DOCKER_SANDBOX_MESSAGES = {
  unverified:
    'the docker sandbox could not start and verify a container: Docker must be running and the ' +
    `runtime image (RUNTIME_IMAGE, by default ${DEFAULT_DOCKER_RUNTIME_IMAGE}) must exist locally, ` +
    `for example built with "docker build -f runtime.Dockerfile -t ${DEFAULT_DOCKER_RUNTIME_IMAGE} ." ` +
    'in the Agent Workspace repository; the runner manager line above names the cause. Or run aw ' +
    'dev without --sandbox docker',
  'no-bridge':
    "the docker sandbox could not read the gateway address of Docker's default bridge network, " +
    'where the model gateway listens for containers; check that "docker network inspect bridge" ' +
    'answers, or run aw dev without --sandbox docker',
} as const;

/** The docker sandbox did not come up; the message says what to check and is safe to print. */
export class DockerSandboxError extends Error {
  constructor(
    reason: keyof typeof DOCKER_SANDBOX_MESSAGES,
    options?: { readonly cause?: unknown },
  ) {
    super(DOCKER_SANDBOX_MESSAGES[reason], options);
    this.name = 'DockerSandboxError';
  }
}

/** A started docker sandbox: where the web reaches its runner manager, and how to stop it. */
export interface DockerSandbox {
  readonly url: string;
  readonly token: string;
  /** Stop the manager and remove every container it started; what it could not remove is logged. */
  close(): Promise<void>;
}

/**
 * The label every sandbox, proxy and network of this project's `aw dev` carries (BH061-079):
 * `aw-dev-<folder>-<hash of the path>`, so `docker ps --filter
 * label=agent-workspace.compose-project=<it>` finds them, two projects never share one, and a
 * clean stop also removes what an earlier, killed session of the same project left behind.
 */
export function devComposeProject(projectRoot: string): string {
  const folder = path
    .basename(projectRoot)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^[-_]+|[-_]+$/gu, '')
    .slice(0, 40);
  const hash = createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 8);
  return `aw-dev-${folder === '' ? 'project' : folder}-${hash}`;
}

/**
 * The runner manager's whole environment: the engine image variables of `env` and fixed values.
 * `NODE_ENV` is `development` because a local session runs a locally built tag; the digest rule of
 * a production manager is for deployments.
 */
export function dockerManagerEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  token: string,
  projectRoot: string = process.cwd(),
): Readonly<Record<string, string>> {
  const images = Object.entries(env).flatMap(([name, value]): [string, string][] =>
    IMAGE_VARIABLE.test(name) && value !== undefined && value.trim() !== ''
      ? [[name, value.trim()]]
      : [],
  );
  return {
    RUNTIME_IMAGE: DEFAULT_DOCKER_RUNTIME_IMAGE,
    ...Object.fromEntries(images),
    RUNTIME_DRIVER: 'docker',
    RUNTIME_PUBLISH: 'loopback',
    COMPOSE_PROJECT_NAME: devComposeProject(projectRoot),
    RUNNER_MANAGER_TOKEN: token,
    HOST: '127.0.0.1',
    PORT: '0',
    NODE_ENV: 'development',
  };
}

/** The run spec the start-up verification asks for: the launcher's `docker` profile. */
const VERIFICATION_RUN_SPEC = {
  runtimeProfileId: 'docker',
  driver: 'docker',
  networkPolicy: 'open',
  filesystem: 'read-write',
  diskMb: 1_024,
} as const;

async function verify(url: string, token: string): Promise<void> {
  const response = await fetch(`${url}/verify`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId: 'local',
      sessionId: `verify-${randomUUID()}`,
      engine: 'claude-agent-sdk',
      runSpec: VERIFICATION_RUN_SPEC,
    }),
    redirect: 'error',
  });
  await response.body?.cancel();
  if (!response.ok) throw new DockerSandboxError('unverified');
}

/** Start the docker sandbox's runner manager and verify it can run a container. */
export async function startDockerSandbox(
  env: Readonly<Record<string, string | undefined>>,
): Promise<DockerSandbox> {
  const token = randomBytes(32).toString('hex');
  const manager = await startRunnerManager(dockerManagerEnvironment(env, token));
  const url = `http://127.0.0.1:${String(manager.address.port)}`;
  // `sandboxes-left` is not thrown: the shutdown has already named each container on stderr.
  const close = async (): Promise<void> => void (await manager.shutdown());
  try {
    await verify(url, token);
  } catch (error) {
    await close();
    throw error instanceof DockerSandboxError
      ? error
      : new DockerSandboxError('unverified', { cause: error });
  }
  return { url, token, close };
}

/**
 * The address the gateway binds so a sandbox reaches it at `host.docker.internal`. Docker Desktop
 * (macOS, Windows) forwards that name to the host's loopback, so `127.0.0.1` stays. On Linux it is
 * the default bridge's gateway (`host-gateway`), a host address only containers on that bridge and
 * the host reach; every gateway request still needs a run token.
 */
// ponytail: Docker Desktop on Linux and rootless Docker are not detected; their bridge address is
// not a host address, so the gateway cannot bind it and the start fails.
export async function dockerGatewayHost(
  platform: NodeJS.Platform = process.platform,
  docker: DockerCommand = runDockerCommand,
): Promise<string> {
  if (platform !== 'linux') return '127.0.0.1';
  const inspected = await docker([
    'network',
    'inspect',
    'bridge',
    '--format',
    '{{range .IPAM.Config}}{{.Gateway}}{{end}}',
  ]).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
  const address = inspected.stdout.trim();
  if (inspected.exitCode !== 0 || !isIPv4(address)) throw new DockerSandboxError('no-bridge');
  return address;
}
