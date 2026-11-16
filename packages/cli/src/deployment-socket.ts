import { DOCKER_COMMAND_TIMEOUT_MS, type DockerCommand, runDocker } from './deployment-docker.ts';

/**
 * How long `start` waits for the daemon to report its socket's group. The first run may pull the
 * PostgreSQL image, which `docker compose up` pulls next anyway; past this, `start` keeps the
 * `.env` value, and the runner check after `up` names `DOCKER_GID` if that value is wrong.
 */
export const DOCKER_SOCKET_GROUP_PROBE_TIMEOUT_MS = 120_000;

/**
 * The group that owns `/var/run/docker.sock` on the Docker daemon Compose talks to, read by a
 * short-lived container of the project's already digest-pinned PostgreSQL image (its `stat`) that
 * mounts the socket exactly as the runner does. Statting this machine's file instead is wrong
 * whenever the daemon is elsewhere: `DOCKER_HOST` or a docker context naming a remote, VM or
 * docker-in-docker daemon, or Windows and macOS with a remote Linux daemon (#389).
 *
 * `undefined` when the daemon gives no usable answer in time; the caller keeps `.env`'s value.
 */
export function daemonSocketGroupId(
  environment: NodeJS.ProcessEnv,
  image: string,
  run: DockerCommand = runDocker,
): number | undefined {
  const result = run(
    [
      'run',
      '--rm',
      '--quiet',
      '--network',
      'none',
      '--entrypoint',
      'stat',
      '--volume',
      '/var/run/docker.sock:/var/run/docker.sock:ro',
      image,
      '-c',
      '%g',
      '/var/run/docker.sock',
    ],
    { env: environment, timeout: DOCKER_SOCKET_GROUP_PROBE_TIMEOUT_MS },
  );
  const answer = result.stdout.trim();
  if (result.status !== 0 || !/^\d{1,10}$/u.test(answer)) return undefined;
  return Number(answer);
}

/**
 * Set the `DOCKER_GID` the runner joins for this start. The daemon's answer wins over `.env`: it
 * is the group the mounted socket really has, and on native Linux and Docker Desktop it equals the
 * value the generator wrote, so nothing changes there. A different answer is used for this run and
 * reported; `.env` is left as the operator wrote it.
 */
export function applyDaemonSocketGroupId(
  environment: Record<string, string>,
  composeEnvironment: NodeJS.ProcessEnv,
  run: DockerCommand,
): void {
  const image = environment['POSTGRES_IMAGE'];
  if (image === undefined) return;
  // It lands in `docker run`'s argv: a leading `-` would be read as an option, not an image.
  if (image.startsWith('-')) {
    throw new Error(`POSTGRES_IMAGE in .env must be an image reference, not ${image}`);
  }
  process.stdout.write('Checking the Docker socket group on the daemon…\n');
  const probed = daemonSocketGroupId(composeEnvironment, image, run);
  if (probed === undefined) return;
  const groupId = String(probed);
  const configured = environment['DOCKER_GID'];
  if (configured === groupId) return;
  composeEnvironment['DOCKER_GID'] = groupId;
  process.stdout.write(
    `The Docker socket on the daemon belongs to group ${groupId}, not DOCKER_GID=` +
      `${configured ?? '(unset)'} in .env; the runner joins group ${groupId} for this start. ` +
      `Set DOCKER_GID=${groupId} in .env to record it.\n`,
  );
}

/**
 * The runner's own view of the socket once it is up: a `/_ping` over `/var/run/docker.sock` as the
 * runner's user. Exit 13 is `EACCES`, the one answer that names `DOCKER_GID`; anything else (a
 * runner image without `node`, a daemon hiccup) is not this check's to fail a start on.
 */
export const RUNNER_SOCKET_PING =
  "require('node:http').get({socketPath:'/var/run/docker.sock',path:'/_ping'}," +
  'r=>{r.resume();process.exit(r.statusCode===200?0:1)})' +
  ".on('error',e=>process.exit(e.code==='EACCES'?13:1))";

function describeRunnerSocketDenied(dockerGroupId: string | undefined): string {
  return (
    'The runner cannot use the Docker socket: permission denied on /var/run/docker.sock, so the ' +
    'Docker runtime cannot start a sandbox. The runner joins group ' +
    `DOCKER_GID=${dockerGroupId ?? '(unset)'}, which does not match the socket group, or ` +
    'SELinux/AppArmor denies the socket. Set DOCKER_GID in ' +
    '.env to the group id of /var/run/docker.sock on the Docker host (`stat -c %g ' +
    '/var/run/docker.sock` there) and run `agent-workspace start` again. The containers are left ' +
    'running; `docker compose down` stops the project.'
  );
}

export function assertRunnerCanUseSocket(
  directory: string,
  composeEnvironment: NodeJS.ProcessEnv,
  run: DockerCommand,
): void {
  const result = run(['compose', 'exec', '-T', 'runner', 'node', '-e', RUNNER_SOCKET_PING], {
    cwd: directory,
    env: composeEnvironment,
    timeout: DOCKER_COMMAND_TIMEOUT_MS,
  });
  if (result.status === 13) {
    throw new Error(describeRunnerSocketDenied(composeEnvironment['DOCKER_GID']));
  }
}
