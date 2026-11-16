import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';

/** Runs one `docker` command to completion; injected by the suite. */
export type DockerCommand = (
  argv: readonly string[],
  options: { readonly cwd?: string; readonly env: NodeJS.ProcessEnv; readonly timeout: number },
) => { readonly status: number | null; readonly stdout: string; readonly stderr?: string };

export const runDocker: DockerCommand = (argv, options) => {
  const result = spawnSync('docker', [...argv], {
    ...options,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const missing = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: missing ? 'docker is not installed or not on PATH' : stderr,
  };
};

/** How long `start` waits for `docker compose down`, or for the runner's socket check. */
export const DOCKER_COMMAND_TIMEOUT_MS = 60_000;

/** Runs `docker context inspect`; injected by the suite. */
export type DockerContextInspector = (environment: NodeJS.ProcessEnv) => {
  readonly status: number | null;
  readonly stdout: string;
};

/**
 * `docker context inspect` reads local context metadata and never calls the daemon, so this bounds
 * a stuck docker CLI, not a hung daemon; a killed process reads as an unreadable endpoint.
 */
export const DOCKER_CONTEXT_INSPECT_TIMEOUT_MS = 5_000;

function inspectDockerContext(environment: NodeJS.ProcessEnv) {
  return spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
    encoding: 'utf8',
    env: environment,
    shell: false,
    timeout: DOCKER_CONTEXT_INSPECT_TIMEOUT_MS,
  });
}

/**
 * The daemon endpoint `docker compose` uses with this environment: `DOCKER_HOST` when it is set,
 * otherwise the endpoint of the current `docker context` (which `DOCKER_CONTEXT` selects). An
 * endpoint that cannot be read is `undefined`, and the web URL falls back to this machine.
 */
export function dockerEndpoint(
  environment: NodeJS.ProcessEnv,
  inspect: DockerContextInspector = inspectDockerContext,
): string | undefined {
  const host = environment['DOCKER_HOST'];
  if (host !== undefined && host !== '') return host;
  const result = inspect(environment);
  const endpoint = result.status === 0 ? result.stdout.trim() : '';
  return endpoint === '' ? undefined : endpoint;
}

/**
 * The generator's `DOCKER_GID`: the group of this machine's socket on Linux, else 0 (Docker
 * Desktop's socket). Generating pulls and runs nothing, so this is only a default: `start` asks the
 * daemon it actually talks to (`daemonSocketGroupId`) and uses that answer when the two differ.
 */
export async function dockerSocketGroupId(): Promise<number> {
  if (process.platform !== 'linux') return 0;
  try {
    return (await stat('/var/run/docker.sock')).gid;
  } catch {
    return 0;
  }
}
