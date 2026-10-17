import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  assertComposeProjectName,
  parseEnvironment,
  runDocker,
  type DockerCommand,
} from './deployment.ts';
import { COMPOSE_PROJECT_CREATE_COMMAND } from './profile.ts';

/**
 * `agent-workspace stop`: take the generated Compose project down, and everything its runner
 * started beside it (issue #394).
 *
 * `docker compose down` removes only the containers and networks Compose created. The runner
 * starts each session's sandbox itself, through the Docker socket, on the project's
 * `<project>-runtime-control` network; Compose knows nothing of those containers, and cannot
 * remove that network while one of them is still attached. The runner removes its sandboxes when
 * it is stopped, but a runner that was killed, or a sandbox started by an older release, is left.
 * `stop` therefore runs `down`, then removes whatever of this project is still there, and fails
 * unless nothing is.
 *
 * Only containers that carry the sandbox label are ever removed, and only when they also carry
 * this project's label or sit on this project's runtime-control network. Only networks Compose
 * created for this project, or that the runtime driver created and labelled for it, are removed.
 * Named volumes are kept unless `--volumes` is given; a sandbox's own anonymous workspace volume
 * is always removed with it, as the runner itself does.
 */

/**
 * The sandbox and project labels the runtime driver writes. Restated, not imported: a published
 * package must not name the private runtime package (ADR-0082), and
 * `packages/embedded/src/runtime-pins.test.ts` holds both to their source.
 */
export const SANDBOX_LABEL = 'agent-workspace.runtime=docker';
export const COMPOSE_PROJECT_LABEL = 'agent-workspace.compose-project';
const RUNTIME_NETWORK_LABEL = 'agent-workspace.runtime=docker-network';
/** Compose's own label on every network it creates for a project. */
const COMPOSE_NETWORK_PROJECT_LABEL = 'com.docker.compose.project';

const DOCKER_TIMEOUT_MS = 60_000;

const STOP_USAGE = 'Usage: agent-workspace stop [--volumes]';

/** Runs `docker compose down`, showing its output; injected by the suite. */
export type ComposeDown = (
  directory: string,
  environment: NodeJS.ProcessEnv,
  removeVolumes: boolean,
) => Promise<number>;

const composeDown: ComposeDown = (directory, environment, removeVolumes) => {
  const compose = spawn(
    'docker',
    ['compose', 'down', '--remove-orphans', ...(removeVolumes ? ['--volumes'] : [])],
    { cwd: directory, env: environment, stdio: 'inherit', shell: false },
  );
  return new Promise((resolve, reject) => {
    compose.once('error', reject);
    compose.once('close', (code: number | null) => {
      resolve(code ?? 1);
    });
  });
};

export interface StopOptions {
  readonly directory?: string;
  readonly down?: ComposeDown;
  readonly docker?: DockerCommand;
  readonly out?: Pick<NodeJS.WriteStream, 'write'>;
}

function parseStopArguments(argv: readonly string[]): { readonly removeVolumes: boolean } {
  let removeVolumes = false;
  // `pnpm stop --volumes` forwards the `--` itself; a lone leading one ends no options here.
  const argumentsGiven = argv[0] === '--' ? argv.slice(1) : argv;
  for (const argument of argumentsGiven) {
    if (argument === '--volumes' || argument === '-v') removeVolumes = true;
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}. ${STOP_USAGE}`);
  }
  return { removeVolumes };
}

/**
 * The ids one `docker ... --quiet` listing prints. A listing that fails is an error, not an empty
 * answer: reading it as "nothing left" would report a stop that removed nothing as complete.
 * `tolerant` is for the one filter that legitimately fails, a network that no longer exists.
 */
function idsFrom(
  docker: DockerCommand,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  directory: string,
  tolerant = false,
): string[] {
  const result = docker(argv, { cwd: directory, env, timeout: DOCKER_TIMEOUT_MS });
  if (result.status !== 0) {
    if (tolerant) return [];
    throw new Error(
      `\`docker ${argv.join(' ')}\` failed (status ${String(result.status)}), so what is left of ` +
        'the project cannot be listed. Check that Docker is running, then run `agent-workspace stop` again.',
    );
  }
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The sandboxes of this project the daemon still has: by label, and, for older ones, by network. */
function leftoverSandboxes(
  docker: DockerCommand,
  project: string,
  env: NodeJS.ProcessEnv,
  directory: string,
): string[] {
  const list = (filter: string, tolerant = false) =>
    idsFrom(
      docker,
      ['ps', '--all', '--quiet', '--filter', `label=${SANDBOX_LABEL}`, '--filter', filter],
      env,
      directory,
      tolerant,
    );
  return [
    ...new Set([
      ...list(`label=${COMPOSE_PROJECT_LABEL}=${project}`),
      // A sandbox started before the project label existed carries only the sandbox label; the
      // runtime-control network is named after the project, so membership identifies it.
      ...list(`network=${project}-runtime-control`, true),
    ]),
  ];
}

/** The networks of this project the daemon still has: Compose's, and the runtime driver's. */
function leftoverNetworks(
  docker: DockerCommand,
  project: string,
  env: NodeJS.ProcessEnv,
  directory: string,
): string[] {
  const list = (filters: readonly string[]) =>
    idsFrom(
      docker,
      ['network', 'ls', '--quiet', ...filters.flatMap((filter) => ['--filter', filter])],
      env,
      directory,
    );
  return [
    ...new Set([
      ...list([`label=${COMPOSE_NETWORK_PROJECT_LABEL}=${project}`]),
      ...list([`label=${RUNTIME_NETWORK_LABEL}`, `label=${COMPOSE_PROJECT_LABEL}=${project}`]),
    ]),
  ];
}

function describeMissingDocker(error: unknown): Error {
  return new Error(
    'Docker is not installed or not on PATH: `agent-workspace stop` runs `docker compose`. ' +
      'Install Docker (https://docs.docker.com/get-docker/) and run the command again.',
    { cause: error },
  );
}

/**
 * `agent-workspace stop [--volumes]`, in the generated project's directory. Resolves only when no
 * container or network of the project is left; otherwise it fails, naming what is.
 */
export async function runStopCommand(
  argv: readonly string[] = process.argv.slice(3),
  options: StopOptions = {},
): Promise<void> {
  const { removeVolumes } = parseStopArguments(argv);
  const directory = options.directory ?? process.cwd();
  const down = options.down ?? composeDown;
  const docker = options.docker ?? runDocker;
  const out = options.out ?? process.stdout;

  let contents: string;
  try {
    contents = await readFile(path.join(directory, '.env'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error(
      `There is no .env in ${directory}. \`agent-workspace stop\` runs in the Compose project ` +
        `\`${COMPOSE_PROJECT_CREATE_COMMAND}\` generates. A kind: Project directory runs with ` +
        '`aw dev`, which Ctrl+C stops.',
      { cause: error },
    );
  }
  const environment = parseEnvironment(contents);
  const project = assertComposeProjectName(environment['COMPOSE_PROJECT_NAME']);
  const env: NodeJS.ProcessEnv = { ...process.env, ...environment };
  /**
   * Claim a removal only when Docker reported one; otherwise pass on what Docker said. The final
   * listing below still decides whether the project is stopped.
   */
  const reportRemoval = (result: ReturnType<DockerCommand>, success: string): void => {
    if (result.status === 0) {
      out.write(`${success}\n`);
      return;
    }
    const said = result.stderr?.trim() ?? '';
    out.write(`${said === '' ? `docker exited with status ${String(result.status)}` : said}\n`);
  };

  let status: number;
  try {
    status = await down(directory, env, removeVolumes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw describeMissingDocker(error);
    throw error;
  }

  const sandboxes = leftoverSandboxes(docker, project, env, directory);
  if (sandboxes.length > 0) {
    const removal = docker(['rm', '--force', '--volumes', ...sandboxes], {
      cwd: directory,
      env,
      timeout: DOCKER_TIMEOUT_MS,
    });
    reportRemoval(
      removal,
      `Removed ${String(sandboxes.length)} runtime sandbox(es) of ${project}.`,
    );
  }
  if (status !== 0) {
    // `down` stops at a network a sandbox still held; with the sandboxes gone it can finish,
    // including the volumes `--volumes` asked for.
    status = await down(directory, env, removeVolumes);
  }
  const networks = leftoverNetworks(docker, project, env, directory);
  if (networks.length > 0) {
    const removal = docker(['network', 'rm', ...networks], {
      cwd: directory,
      env,
      timeout: DOCKER_TIMEOUT_MS,
    });
    reportRemoval(removal, `Removed ${String(networks.length)} network(s) of ${project}.`);
  }

  const remainingSandboxes = leftoverSandboxes(docker, project, env, directory);
  const remainingNetworks = leftoverNetworks(docker, project, env, directory);
  if (remainingSandboxes.length > 0 || remainingNetworks.length > 0 || status !== 0) {
    throw new Error(
      `${project} is not fully stopped: ` +
        [
          status === 0 ? '' : `docker compose down exited with status ${String(status)}`,
          remainingSandboxes.length === 0
            ? ''
            : `sandbox container(s) ${remainingSandboxes.join(', ')} remain`,
          remainingNetworks.length === 0 ? '' : `network(s) ${remainingNetworks.join(', ')} remain`,
        ]
          .filter((part) => part.length > 0)
          .join('; ') +
        '. Check `docker ps -a` and `docker network ls`, then run `agent-workspace stop` again.',
    );
  }
  out.write(
    `${project} is stopped. ${removeVolumes ? 'Its volumes were removed.' : 'Its data volumes are kept; `agent-workspace stop --volumes` also removes them.'}\n`,
  );
}
