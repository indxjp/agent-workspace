import { startComposeDeployment } from './deployment.ts';
import {
  enforceContractsProbe,
  probeServerContracts,
  type ContractsProbe,
  type ProbeOptions,
} from './contracts-skew.ts';
import { COMPOSE_PROJECT_CREATE_COMMAND } from './profile.ts';

/**
 * What `start` says when it has nothing it can start: the embedded workspace is `aw dev`, which
 * runs from a project that `npm create @indx-workspace@latest` writes (`@indx-workspace/embedded`).
 */
export const EMBEDDED_MODE_REFUSAL =
  'The embedded, development-only workspace is `aw dev`: run `npm create @indx-workspace@latest ' +
  'my-agent` and then `npm run dev` in it. The published CLI starts the Compose project that ' +
  `\`${COMPOSE_PROJECT_CREATE_COMMAND}\` generates: run \`agent-workspace start\` in that ` +
  'directory.';

/**
 * Where a directory without a `.env` may have come from: `npm create @indx-workspace` without
 * `--cloud` writes a `kind: Project` directory, which `aw dev` runs (#496). The refusal says so
 * without reading `agent-workspace.yaml`, so it cannot fail in a new way.
 */
const PROJECT_KIND_START_HINT =
  'A kind: Project directory, which `npm create @indx-workspace <directory>` writes without ' +
  '--cloud, runs with `aw dev`.';

/** How long `start` keeps asking the web URL to answer once Compose has reported the project up. */
export const WEB_READY_TIMEOUT_MS = 120_000;
const WEB_READY_INTERVAL_MS = 2_000;
const WEB_PROBE_TIMEOUT_MS = 5_000;

export interface WebReadinessOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  /** Injected by the suite; production probes the URL with `fetch`. */
  readonly probe?: (url: string, options: ProbeOptions) => Promise<ContractsProbe>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Why a started project cannot be used, and what to look at. */
export function describeUnreachableWeb(url: string, reason: string, timeoutMs: number): string {
  return (
    `The web service did not answer at ${url} within ${String(Math.round(timeoutMs / 1000))}s ` +
    `(${reason}), although docker compose reported the project up. The containers are left ` +
    'running. Check `docker compose ps` and `docker compose logs web` in this directory; if ' +
    'another process holds the port, set PORT in .env to a free one and run `agent-workspace ' +
    'start` again. If you use a remote Docker daemon or docker context, open the web URL on that ' +
    'host instead. `docker compose down` stops the project.'
  );
}

/**
 * Why an answer without the contracts headers is a failed start. Every `/api/**` answer of the
 * server this project pins states its contracts version (ADR-0078), so something that answers on
 * the port without them is another process holding it, not the web service just started.
 */
export function describePortConflict(url: string): string {
  const port = new URL(url).port || '80';
  return (
    `Something answered at ${url}, but it is not this project's web service: it states no ` +
    `contracts version. Another process is probably holding port ${port}. Stop it, or set PORT ` +
    'in .env to a free port, and run `agent-workspace start` again. The containers are left ' +
    'running; `docker compose down` stops the project.'
  );
}

/** Hosts a browser treats as a secure context over plain http. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * What to do when the web URL is plain http at an address other than loopback, as `start` prints
 * for a remote Docker daemon. The session cookie is `__Host-` and `Secure`, which browsers keep
 * only over HTTPS or on localhost, so a sign-in there would never stick. The cookie stays `Secure`
 * (#389): deriving it from the request protocol would also relax it behind a TLS-terminating proxy
 * that forwards plain http, so `start` names the two ways that work instead.
 */
export function describeInsecureSignIn(url: string): string | undefined {
  const { protocol, hostname, port } = new URL(url);
  if (protocol !== 'http:' || LOOPBACK_HOSTS.has(hostname)) return undefined;
  const webPort = port || '80';
  return (
    `Browsers keep the sign-in cookie only over HTTPS or on localhost, so a sign-in at ${url} ` +
    'will not stick. Forward the port to this machine (for example `ssh -L ' +
    `${webPort}:127.0.0.1:${webPort} <user>@${hostname}\`) and open ` +
    `http://localhost:${webPort}/setup, or serve the project over HTTPS.`
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask the web URL until it answers, or fail. `docker compose up --wait` only proves the
 * containers are running: a port Docker never published, or a server still booting, looks the same
 * to it. A project whose web URL never answers is a failed start, not a warning.
 */
export async function waitForWebUrl(
  url: string,
  options: WebReadinessOptions = {},
): Promise<ContractsProbe> {
  const timeoutMs = options.timeoutMs ?? WEB_READY_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? WEB_READY_INTERVAL_MS;
  const probe = options.probe ?? probeServerContracts;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + timeoutMs;
  for (;;) {
    const result = await probe(url, { timeoutMs: WEB_PROBE_TIMEOUT_MS });
    if (result.kind !== 'unreachable') return result;
    if (now() >= deadline) throw new Error(describeUnreachableWeb(url, result.reason, timeoutMs));
    await sleep(intervalMs);
  }
}

/**
 * `agent-workspace start`: bring the generated Compose project up, require its web URL to answer,
 * then refuse a server whose contracts version this CLI cannot operate. A refused or unreachable
 * deployment is left running: `docker compose down` in the project stops it.
 */
export async function runStartCommand(
  argv: readonly string[] = process.argv.slice(3),
  options: WebReadinessOptions = {},
): Promise<void> {
  if (argv.includes('--embedded')) throw new Error(EMBEDDED_MODE_REFUSAL);
  let url: string;
  try {
    url = await startComposeDeployment();
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code !== 'ENOENT') throw error;
    if (failure.syscall === 'spawn docker' || failure.path === 'docker') {
      throw new Error(
        'Docker is not installed or not on PATH: `agent-workspace start` runs `docker compose`. ' +
          'Install Docker (https://docs.docker.com/get-docker/) and run the command again.',
        { cause: error },
      );
    }
    throw new Error(
      `There is no .env in ${process.cwd()}. ${PROJECT_KIND_START_HINT} ${EMBEDDED_MODE_REFUSAL}`,
      { cause: error },
    );
  }
  const probe = await waitForWebUrl(url, options);
  if (probe.kind === 'no-headers') throw new Error(describePortConflict(url));
  enforceContractsProbe(probe, url);
  // BH061-078: /setup is only the first run's step; afterwards it is the wrong page to open.
  process.stdout.write(
    `Agent Workspace is up: ${url} (first run: create the owner at ${url}/setup)\n`,
  );
  const signIn = describeInsecureSignIn(url);
  if (signIn !== undefined) process.stdout.write(`${signIn}\n`);
}
