import { realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { type DockerCommand } from './deployment-docker.ts';

/**
 * What `docker compose up` writes when the host port `web` publishes is taken on the Docker host:
 * the engine's `address already in use`, `port is already allocated` when another container holds
 * it, or Docker Desktop's `ports are not available` (whose WinSock tail is localised on Windows).
 * Compose leaves every service it had already started running.
 */
export const HOST_PORT_IN_USE =
  /failed to bind host port|address already in use|port is already allocated|ports are not available/iu;

/** Where the web URL points when the Docker daemon runs on this machine. */
const LOCAL_WEB_HOST = '127.0.0.1';

/** What happened to the project when its web port turned out to be taken. */
type PortConflictOutcome = 'not-started' | 'stopped' | 'stop-failed';

/**
 * The failed-start message for a host port the web service cannot be published on: the same
 * guidance `start` gives when another process answers on the port (`describePortConflict`), plus
 * what happened to the project. The pre-flight check (`assertWebPortFree`) finds the port taken
 * before anything starts; a bind failure of `compose up` finds it after some services started.
 */
export function describeHostPortInUse(
  url: string,
  outcome: PortConflictOutcome,
  holder?: string,
): string {
  const port = new URL(url).port || '80';
  const cleanup = {
    'not-started': 'Nothing was started.',
    stopped:
      'The services it had already started were stopped with `docker compose down`; the data ' +
      'volumes are kept.',
    'stop-failed':
      'Stopping the services it had already started failed: run `docker compose down` in this ' +
      'directory (the data volumes are kept).',
  }[outcome];
  const subject =
    outcome === 'not-started'
      ? `The web service cannot be published on ${url}`
      : `docker compose could not publish the web service on ${url}`;
  return (
    `${subject}: port ${port} is already in use on the Docker host` +
    `${holder === undefined ? '' : ` (${holder})`}. Stop the process holding port ${port}, or ` +
    `set PORT in .env to a free port, and run \`agent-workspace start\` again. ${cleanup}`
  );
}

/** Whether this machine can bind a TCP port on every address; injected by the suite. */
export type HostPortProbe = (port: number) => Promise<boolean>;

/**
 * Bind the port the way Docker publishes it (every address) and let it go again. Only
 * `EADDRINUSE` reads as taken: any other refusal is left for `compose up` to report, since the
 * Docker daemon, not this process, does the real bind.
 */
export const hostPortFree: HostPortProbe = (port) =>
  new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code !== 'EADDRINUSE');
    });
    server.listen({ port, exclusive: true }, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });

/** How long `start` waits for `docker ps` to list the daemon's published ports. */
const DOCKER_PS_TIMEOUT_MS = 30_000;

/**
 * Whether a `docker ps` Ports column publishes `port` on the host: a single port
 * (`0.0.0.0:3000->3000/tcp`) or a range that covers it (`0.0.0.0:3000-3005->3000-3005/tcp`).
 */
function publishesHostPort(ports: string, port: number): boolean {
  for (const match of ports.matchAll(/:(\d+)(?:-(\d+))?->/gu)) {
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    if (port >= first && port <= last) return true;
  }
  return false;
}

/** How this project's own containers are recognised in `docker ps`. */
export interface OwnProject {
  /** `path.resolve` of the project directory: Compose's `project.working_dir` label. */
  readonly workingDir: string;
  /** `COMPOSE_PROJECT_NAME` from the shell or `.env`, when it is set. */
  readonly name: string | undefined;
}

/**
 * A directory's physical path, or its resolved path when it cannot be read (a daemon's path that
 * does not exist here). Compose records the logical `$PWD`, which may pass through a symlink, while
 * Node's `process.cwd()` is physical, so both sides are compared physically.
 */
export function realPathOrResolved(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return path.resolve(directory);
  }
}

function isOwnContainer(project: string, workingDir: string, own: OwnProject): boolean {
  if (workingDir !== '' && realPathOrResolved(workingDir) === own.workingDir) return true;
  return own.name !== undefined && project === own.name;
}

/** What `docker ps` says about the port: unknown, free of containers, ours, or another's. */
type PublishedPort =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'free' }
  | { readonly kind: 'ours' }
  | { readonly kind: 'taken'; readonly holder: string };

/**
 * Which project's container publishes the web port, if any. A container is this project's own
 * when Compose labelled it with this directory as its working directory, or with the
 * `COMPOSE_PROJECT_NAME` this start runs under. A name derived from the directory's basename is not
 * used: another project in a directory of the same name would pass for this one.
 */
function containerPublishing(
  port: number,
  own: OwnProject,
  environment: NodeJS.ProcessEnv,
  docker: DockerCommand,
): PublishedPort {
  const listing = docker(
    [
      'ps',
      '--format',
      '{{.Label "com.docker.compose.project"}}\t' +
        '{{.Label "com.docker.compose.project.working_dir"}}\t{{.Names}}\t{{.Ports}}',
    ],
    { env: environment, timeout: DOCKER_PS_TIMEOUT_MS },
  );
  // A daemon that cannot list its containers fails `compose up` with its own message.
  if (listing.status !== 0) return { kind: 'unknown' };
  for (const line of listing.stdout.split(/\r?\n/u)) {
    const [project = '', workingDir = '', name = '', ports = ''] = line.split('\t');
    if (!publishesHostPort(ports, port)) continue;
    if (isOwnContainer(project, workingDir, own)) return { kind: 'ours' };
    return {
      kind: 'taken',
      holder:
        project === ''
          ? `by container ${name}`
          : `by container ${name} of Compose project ${project}`,
    };
  }
  return { kind: 'free' };
}

/**
 * Refuse a taken web port before `compose up`, which otherwise pulls every image and starts
 * postgres, the runner and the gateway before it reaches the web bind (#396). The daemon's own
 * published ports are asked first, local or remote: a container of this project holding the port
 * is the project already running, which `up` leaves as it is. Only when that listing shows no
 * container on the port, and the daemon is local, is the port bound on this machine, which also
 * finds a process that is not a container. When the listing fails, a failed bind could be this
 * project's own container, so nothing is refused here. A remote daemon's host cannot be bound from
 * here at all. In both cases the bind failure of `compose up` is translated as before.
 */
export async function assertWebPortFree(
  url: string,
  own: OwnProject,
  composeEnvironment: NodeJS.ProcessEnv,
  probes: { readonly docker: DockerCommand; readonly hostPortFree: HostPortProbe },
): Promise<void> {
  const { hostname, port: urlPort } = new URL(url);
  const port = Number(urlPort || '80');
  const published = containerPublishing(port, own, composeEnvironment, probes.docker);
  if (published.kind === 'taken') {
    throw new Error(describeHostPortInUse(url, 'not-started', published.holder));
  }
  if (published.kind !== 'free' || hostname !== LOCAL_WEB_HOST) return;
  if (!(await probes.hostPortFree(port))) {
    throw new Error(describeHostPortInUse(url, 'not-started'));
  }
}

/**
 * Where the published web port answers. Compose publishes it on the Docker host, which is this
 * machine unless `DOCKER_HOST` names a remote daemon over `tcp://` or `ssh://`; a local socket or
 * pipe (`unix://`, `npipe://`) is this machine.
 */
export function webUrl(environment: Record<string, string>, dockerHost?: string): string {
  // Compose's `ip:port` short form publishes on that address only (`aw deploy` sets loopback).
  const published = environment['PORT'] || '3000';
  const separator = published.lastIndexOf(':');
  const port = published.slice(separator + 1);
  let host = separator === -1 ? LOCAL_WEB_HOST : published.slice(0, separator);
  if (dockerHost !== undefined && /^(?:tcp|ssh):\/\//u.test(dockerHost)) {
    try {
      const { hostname } = new URL(dockerHost);
      if (hostname !== '') host = hostname;
    } catch {
      // An unparsable DOCKER_HOST is docker's to refuse; this machine is the only address left.
    }
  }
  return `http://${host}:${port}`;
}
