/**
 * `deploy` for a Cloudflare target: Wrangler (ADR-0094, ADR-0120 clauses 7 and 8, ADR-0125,
 * ADR-0127, ADR-0129).
 *
 * A deployment is up to five Workers: the model gateway (`<name>-gateway`) and the runner manager
 * (`<name>-manager`), each its image as a Container behind a routing Worker, the control plane
 * (`<name>-control-plane`, the same), the frontend (`<name>-web`, the project's `web/` build as static
 * assets, only when the project has one) and the retention Worker (`<name>`, a Cron Trigger).
 *
 * On apply it pushes the web, gateway and runner images to Cloudflare's registry, runs the database
 * migrations once, deploys the Workers (gateway and manager before the control plane that calls
 * them, the frontend after it), and uploads each Worker's secrets. An image is tagged by its digest,
 * so one already in the registry is not pushed again (nor one `.env` names on
 * `registry.cloudflare.com`, which is used as it is); the Workers' configurations are deployed from
 * copies that name the registry reference, and the copies are removed. The migrations are a deploy
 * step and not a cold start (ADR-0127): they run the web image's own `migrate.js` and `seed.js`
 * under the Postgres advisory lock, as the Vercel target does, and a failure stops before any Worker
 * is deployed, so the live control plane keeps the schema it has.
 *
 * The last steps wait until the control plane answers `/setup` and the runner manager answers
 * `/healthz` with 200, because `wrangler deploy` returns before Cloudflare has started the
 * containers; a Worker that never answers is a named error, not "Applied".
 *
 * Each Worker answers at `https://<worker>.<CLOUDFLARE_WORKERS_SUBDOMAIN>.workers.dev` (`MODEL_GATEWAY_URL`
 * and `RUNNER_MANAGER_URL` in `.env` name a custom domain instead). The control plane is given the
 * gateway and manager addresses, and, when there is a frontend, `AW_FRONTEND_ORIGIN`: exactly that
 * frontend Worker's `https://` origin, which web adds to the production surface's allowed origins
 * (never a wildcard). The frontend is built with `VITE_AW_BASE_URL` set to `CONTROL_PLANE_URL`.
 *
 * The master key and the database URL go to the control plane's and the gateway's secrets only,
 * never to the manager, the frontend or the retention Worker (ADR-0120 clause 8).
 *
 * The token and account id are read from the environment and reach Wrangler only through the
 * child's environment; they are never an argument, which `runStep` echoes and the process list
 * shows. Each container Worker's secrets reach `wrangler secret bulk` as one JSON object on stdin
 * (one upload per Worker, not one call per secret), the retention Worker's two reach `wrangler
 * secret put` on stdin, and `DATABASE_URL` reaches the migration container through the `docker`
 * child's environment (`-e NAME` names it in argv, never its value), for the same reason. Every
 * apply uploads the current values. A rotated value reaches a running container because its Worker
 * hashes (SHA-256) the environment it starts the container with, keeps the hash in Durable Object
 * storage, and on a request whose bindings hash differently stops the container and starts it with
 * the new environment; until every required secret is bound it answers 503 and starts nothing
 * (ADR-0127).
 *
 * Vendor facts, checked 2026-10-08: Wrangler reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
 * (https://developers.cloudflare.com/workers/wrangler/system-environment-variables/);
 * `wrangler deploy` takes `--config` and `--name`, `wrangler secret list`
 * takes `--name` and `--format json` and errors when the Worker does not exist, and
 * `wrangler secret put <KEY>` reads the value from stdin and overwrites an existing secret, and
 * `wrangler secret bulk` with no file reads a JSON object `{"NAME": "value", ...}` from stdin and
 * creates or updates every key in it for the Worker `--name` names
 * (https://developers.cloudflare.com/workers/wrangler/commands/workers/); `wrangler containers
 * push <TAG>` pushes a local image to `registry.cloudflare.com/<account id>/<TAG>` and `wrangler
 * containers images list` lists what the registry holds; Containers run `linux/amd64` images only
 * (https://developers.cloudflare.com/containers/platform-details/image-management/,
 * https://developers.cloudflare.com/workers/wrangler/commands/containers/); a Worker is served at
 * `<worker>.<account subdomain>.workers.dev` (https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).
 * None of this has run against a real account yet: that is the live smoke's job (issue #832).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { ignoredStorageVariables } from '@indx-workspace/contracts/storage-settings';
import { formatStorageUrl } from '@indx-workspace/contracts/storage-url';

import {
  addressOf,
  awsCredentials,
  FRONTEND_BASE_URL_VARIABLE,
  FRONTEND_ORIGIN_VARIABLE,
  frontendDirectory,
  gatewayVariables,
  MANAGER_VARIABLES,
  MIGRATE_AND_SEED,
  assertE2bTemplatePinned,
  managerEnvironment,
  MIGRATION_VARIABLES,
  NOT_PROJECT_VARIABLES,
  selected,
  storageTarget,
  withoutIgnoredStorageSettings,
  toolHostVariables,
} from './vercel.ts';
import { runStep, type DeployContext, type DeployOutcome } from './steps.ts';
import type { DeployTarget } from './targets.ts';
import { cloudflareFrontendConfiguration } from '../render/cloudflare.ts';
import { ENV_IMAGE_KEYS } from '../render/env.ts';

type CloudflareTarget = Extract<DeployTarget, { kind: 'cloudflare' }>;

export const CLOUDFLARE_API_TOKEN_VARIABLE = 'CLOUDFLARE_API_TOKEN';
const CLOUDFLARE_ACCOUNT_ID_VARIABLE = 'CLOUDFLARE_ACCOUNT_ID';
const CLOUDFLARE_SUBDOMAIN_VARIABLE = 'CLOUDFLARE_WORKERS_SUBDOMAIN';
const CONTROL_PLANE_URL_VARIABLE = 'CONTROL_PLANE_URL';
const CRON_SECRET_VARIABLE = 'CRON_SECRET';
const BRIDGE_URL_VARIABLE = 'CLOUDFLARE_SANDBOX_BRIDGE_URL';

/** The value of a required setting, or a refusal that names it. */
function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  purpose: string,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set: agent-workspace deploy reads ${purpose} from the environment, never ` +
        'from a flag or the profile. Set it and run again. Nothing was run.',
    );
  }
  return value;
}

/**
 * Ten minutes: a first deploy provisions the container before it can start. A request may take up to
 * 90 s, the Worker's own wait for the container, so a slow first start reaches the caller as the
 * Worker's 503 and its reason rather than as an abort.
 */
const DEFAULT_READINESS = { windowMs: 600_000, delayMs: 5_000, requestTimeoutMs: 90_000 };

const HTML_ANSWER = /^\s*<(?:!doctype|html)/iu;
const CONTAINER_EXITED = /container exited/iu;

/**
 * What an answer says, short enough to read: Cloudflare's own error page is reduced to its title,
 * its `Error NNNN` code and the `cf-ray` that finds it in the dashboard; anything else is cut at
 * 300 characters.
 */
function answerSummary(response: Response, body: string): string {
  if (!HTML_ANSWER.test(body)) return body.slice(0, 300);
  const title = /<title[^>]*>([^<]*)<\/title>/iu.exec(body)?.[1]?.replace(/\s+/gu, ' ').trim();
  const code = /\bError (\d{3,4})\b/u.exec(body)?.[1];
  const ray = response.headers.get('cf-ray');
  const parts = [
    title ? `title: ${title.slice(0, 120)}` : '',
    code === undefined ? '' : `code: Error ${code}`,
    ray === null ? '' : `cf-ray: ${ray.slice(0, 40)}`,
  ].filter((part) => part !== '');
  return title || code !== undefined ? parts.join('; ') : body.slice(0, 300);
}

/**
 * Waits until a container Worker answers `GET <url>` with 200 (the control plane's `/setup` and the
 * runner manager's `/healthz` are both auth-exempt, so a redirect is not an answer). `wrangler
 * deploy` returns before the container exists: Cloudflare starts it on the first request, and the
 * Worker answers 503 with the reason until it can serve. What the last request saw goes to stderr,
 * redacted; the error carries only the status or the failure's name.
 */
async function waitForWorker(
  context: DeployContext,
  label: 'control plane' | 'runner manager',
  workerName: string,
  url: string,
): Promise<void> {
  const { windowMs, delayMs, requestTimeoutMs } = context.readiness ?? DEFAULT_READINESS;
  const get = context.fetch ?? globalThis.fetch;
  context.out(`Waiting for the ${label} at ${url} to answer.\n`);
  let last: string;
  let seen: string;
  const deadline = Date.now() + windowMs;
  let requests = 0;
  for (;;) {
    requests += 1;
    try {
      const response = await get(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.status === 200) return;
      last = `HTTP ${String(response.status)}`;
      seen = answerSummary(response, await response.text());
    } catch (error) {
      last = `network error (${error instanceof Error ? error.name : 'unknown'})`;
      seen = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
    }
    if (Date.now() + delayMs >= deadline) break;
    await sleep(delayMs);
  }
  context.err(`Last answer from ${url}: ${last} ${JSON.stringify(seen)}\n`);
  throw new Error(
    `The ${label} Worker ${workerName} did not answer ${url} with 200 in ` +
      `${String(windowMs / 1000)} s (${String(requests)} requests); last: ${last}. The Workers and secrets were applied; its ` +
      `answer is above. Run deploy again, or watch \`wrangler tail ${workerName}\`.` +
      (CONTAINER_EXITED.test(seen)
        ? ' The container exited: the reason it printed is in its log (Cloudflare dashboard, ' +
          `Compute > Containers > ${workerName}), not in this answer.`
        : ''),
  );
}

/** Waits before each retry of a step that just created a Worker: 17 s in all. */
const WORKER_PROPAGATION_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];

/**
 * Wrangler's error 10007 right after a successful upload: Cloudflare's API has not caught up with
 * the Worker it just created, and the same call succeeds a moment later. Nothing else is retried.
 */
export const isWorkerPropagating = (output: string): boolean => /\[code: 10007\]/u.test(output);

/** The retry of a step that deploys a Worker or uploads its secrets right after the deploy. */
const afterUpload = (context: DeployContext) => ({
  when: isWorkerPropagating,
  delaysMs: context.workerRetryDelaysMs ?? WORKER_PROPAGATION_DELAYS_MS,
});

const WORKER_NOT_FOUND = /not found|does not exist|10007/iu;
const BUCKET_NOT_FOUND = /not found|does not exist|10006/iu;

type Secrets = readonly (readonly [string, string])[];

/** An image the Workers run, and where Cloudflare's registry holds it. */
interface RegistryImage {
  readonly label: string;
  /** The reference in `.env`, digest-pinned. */
  readonly reference: string;
  /** What a local `docker tag` and `wrangler containers push` name it: content-addressed. */
  readonly localTag: string;
  /** The tag alone, `sha256-<digest>`. */
  readonly tag: string;
  /** What a Worker's configuration names after the push. */
  readonly registryReference: string;
}

function registryImage(
  dotEnv: Readonly<Record<string, string>>,
  service: 'web' | 'gateway' | 'runner',
  account: string,
): RegistryImage {
  const key = ENV_IMAGE_KEYS[service];
  const reference = dotEnv[key]?.trim() ?? '';
  const digest = /@sha256:([0-9a-f]{64})$/u.exec(reference)?.[1];
  if (digest === undefined) {
    throw new Error(
      `${key} is ${JSON.stringify(reference)} in .env: it must be pinned by digest ` +
        '(name@sha256:<64 hex digits>), because the Cloudflare registry tag is the digest and an ' +
        'unchanged image is not pushed again. Nothing was run.',
    );
  }
  const tag = `sha256-${digest}`;
  // Already in Cloudflare's registry: the Workers run it as it is, and nothing is pushed.
  if (reference.startsWith('registry.cloudflare.com/')) {
    return { label: service, reference, localTag: reference, tag, registryReference: reference };
  }
  const repository = `agent-workspace-${service}`;
  return {
    label: service,
    reference,
    localTag: `${repository}:${tag}`,
    tag,
    registryReference: `registry.cloudflare.com/${account}/${repository}:${tag}`,
  };
}

/** Whether the registry already holds `image`: named there in `.env`, or its digest tag listed. */
const inRegistry = (image: RegistryImage, listing: string) =>
  image.registryReference === image.reference || listing.includes(image.tag);

/** Push each image the registry does not hold yet: pull for `linux/amd64`, tag by digest, push. */
async function pushImages(
  context: DeployContext,
  images: readonly RegistryImage[],
  listing: string,
): Promise<void> {
  for (const image of images) {
    if (inRegistry(image, listing)) {
      context.out(`Image ${image.label} (${image.tag}) is already in the Cloudflare registry.\n`);
      continue;
    }
    await runStep(context, 'docker', ['pull', '--platform', 'linux/amd64', image.reference], {
      show: false,
    });
    await runStep(context, 'docker', ['tag', image.reference, image.localTag], { show: false });
    await runStep(context, 'wrangler', ['containers', 'push', image.localTag], { show: true });
  }
}

/** Run `use` with `configuration` written to a file outside the project, then remove the file. */
async function withTemporaryConfiguration<T>(
  fileName: string,
  configuration: unknown,
  use: (file: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), 'aw-cloudflare-'));
  try {
    const file = path.join(directory, fileName);
    await writeFile(file, JSON.stringify(configuration, null, 2) + '\n');
    return await use(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A container Worker's rendered configuration with its image replaced by the one pushed to the
 * registry and the Worker named. It is deployed from a copy outside the project, so `main` is made
 * absolute. Wrangler validates the file before it applies `--name`, and refuses a `containers` entry
 * without a top-level `name`; the rendered file stays name-free so one file serves every
 * deployment (ADR-0125), and the name is stamped here, where `--name` is known.
 */
async function registryConfiguration(
  source: string,
  image: RegistryImage,
  name: string,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(source, 'utf8'));
  } catch (error) {
    throw new Error(
      `${source} is not readable JSON: render the project again, or restore the file. Nothing was applied.`,
      { cause: error },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} is not a JSON object. Nothing was applied.`);
  }
  const configuration = parsed as Record<string, unknown>;
  const containers = Array.isArray(configuration['containers']) ? configuration['containers'] : [];
  const main = typeof configuration['main'] === 'string' ? configuration['main'] : '';
  return {
    ...configuration,
    name,
    main: path.resolve(path.dirname(source), main),
    containers: containers.map((container: unknown) =>
      typeof container === 'object' && container !== null
        ? { ...container, image: image.registryReference }
        : container,
    ),
  };
}

/** The account and addresses a deploy needs from the environment, each refused by name. */
function readSettings(context: DeployContext, dotEnv: Readonly<Record<string, string>>) {
  required(context.env, CLOUDFLARE_API_TOKEN_VARIABLE, 'the Cloudflare API token');
  const account = required(
    context.env,
    CLOUDFLARE_ACCOUNT_ID_VARIABLE,
    'the Cloudflare account id',
  );
  const subdomain = required(
    { ...dotEnv, ...context.env },
    CLOUDFLARE_SUBDOMAIN_VARIABLE,
    'the account subdomain the Workers answer under (workers.dev)',
  ).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(subdomain)) {
    throw new Error(
      `${CLOUDFLARE_SUBDOMAIN_VARIABLE} must be the account's workers.dev subdomain, the label ` +
        `before ".workers.dev"; got ${JSON.stringify(subdomain)}. Nothing was run.`,
    );
  }
  const controlPlane = required(
    { ...dotEnv, ...context.env },
    CONTROL_PLANE_URL_VARIABLE,
    'the URL the retention Cron Trigger calls',
  );
  if (!/^https:\/\/[^\s]+$/u.test(controlPlane)) {
    throw new Error(
      `${CONTROL_PLANE_URL_VARIABLE} must be an https:// URL; got ${JSON.stringify(controlPlane)}. ` +
        'Nothing was run.',
    );
  }
  return { account, subdomain, controlPlane };
}

/**
 * BH061-027: the settings a plan without the token or account id uses. It runs no Wrangler call, so
 * each unset value is shown as its own name rather than refused.
 */
function offlineSettings(context: DeployContext, dotEnv: Readonly<Record<string, string>>) {
  const value = (environment: Readonly<Record<string, string | undefined>>, name: string) =>
    environment[name]?.trim() || `<${name}>`;
  const settings = { ...dotEnv, ...context.env };
  return {
    account: value(context.env, CLOUDFLARE_ACCOUNT_ID_VARIABLE),
    subdomain:
      settings[CLOUDFLARE_SUBDOMAIN_VARIABLE]?.trim().toLowerCase() ||
      `<${CLOUDFLARE_SUBDOMAIN_VARIABLE}>`,
    controlPlane: value(settings, CONTROL_PLANE_URL_VARIABLE),
  };
}

/** What an apply needs beyond a plan, refused by name before the first tool runs. */
function readApplySettings(dotEnv: Readonly<Record<string, string>>): Record<string, string> {
  const migration: Record<string, string> = {};
  for (const name of MIGRATION_VARIABLES) {
    const value = dotEnv[name]?.trim() ?? '';
    if (value !== '') migration[name] = value;
  }
  const driver = dotEnv['RUNTIME_DRIVER']?.trim() ?? '';
  for (const name of ['DATABASE_URL', 'BOOTSTRAP_ADMIN']) {
    if ((migration[name] ?? '') === '') {
      throw new Error(
        `${name} is empty in .env: the control plane deploy needs it. Set it and run again. ` +
          'Nothing was run.',
      );
    }
  }
  for (const name of ['RUNNER_MANAGER_TOKEN', 'GATEWAY_TOKEN_SECRET']) {
    if ((dotEnv[name]?.trim() ?? '') === '') {
      throw new Error(
        `${name} is empty in .env: the ${name === 'GATEWAY_TOKEN_SECRET' ? 'gateway' : 'runner manager'} ` +
          'Worker answers 503 until it is set. Set it and run again. Nothing was run.',
      );
    }
  }
  // The skills, files and session-state APIs are not installed without a working R2 key pair, and
  // every `/api/skills*` route then answers 503 `skills_runtime_not_configured`.
  const keys = awsCredentials(dotEnv);
  for (const [name, value] of [
    ['OBJECT_STORAGE_ACCESS_KEY_ID', keys['AWS_ACCESS_KEY_ID']],
    ['OBJECT_STORAGE_SECRET_ACCESS_KEY', keys['AWS_SECRET_ACCESS_KEY']],
  ] as const) {
    if ((value ?? '').trim() === '') {
      throw new Error(
        `${name} is empty in .env: the control plane reaches its R2 bucket with an R2 API ` +
          'token key pair, and without it skills, files and session state answer 503. Set it and ' +
          'run again. Nothing was run.',
      );
    }
  }
  assertE2bTemplatePinned(dotEnv);
  const bridgeUrl = dotEnv[BRIDGE_URL_VARIABLE]?.trim() ?? '';
  if (driver === 'cloudflare-sandbox' && bridgeUrl === '') {
    throw new Error(
      `${BRIDGE_URL_VARIABLE} is empty in .env: the cloudflare-sandbox driver reaches its ` +
        'sandboxes through the bridge Worker at that https URL. Set it and run again. Nothing was run.',
    );
  }
  // The manager refuses to start on anything else (`manager-start.ts`), which would be a 503 loop.
  if (
    driver === 'cloudflare-sandbox' &&
    (!bridgeUrl.startsWith('https://') || !URL.canParse(bridgeUrl))
  ) {
    throw new Error(
      `${BRIDGE_URL_VARIABLE} must be an https URL; got ${JSON.stringify(bridgeUrl)}. ` +
        'Nothing was run.',
    );
  }
  return migration;
}

/** Read-only: whether the retention Worker exists, and what the registry holds. */
async function readAccountState(
  context: DeployContext,
  worker: readonly string[],
): Promise<{ readonly exists: boolean; readonly registryListing: string }> {
  const listing = await runStep(
    context,
    'wrangler',
    ['secret', 'list', ...worker, '--format', 'json'],
    {
      show: false,
      accept: [0, 1],
    },
  );
  const exists = listing.status === 0;
  if (!exists && !WORKER_NOT_FOUND.test(`${listing.stdout}\n${listing.stderr}`)) {
    // Anything else (a rejected token, no network) is not "the Worker is missing".
    context.err(listing.stderr);
    throw new Error(
      `\`wrangler secret list\` failed (exit status ${String(listing.status)}) and did not say ` +
        'the Worker is missing; its output is above. Nothing was applied.',
    );
  }
  // What the registry holds decides which images an apply pushes.
  const registryListing = (
    await runStep(context, 'wrangler', ['containers', 'images', 'list'], { show: false })
  ).stdout;
  return { exists, registryListing };
}

/**
 * The control plane's R2 bucket and the `AW_STORAGE_URL` it is pushed with: the account's R2
 * endpoint and region `auto` fill what the URL leaves out. `overrides` are the secrets that replace
 * `.env`'s own storage values.
 */
function r2Storage(
  dotEnv: Readonly<Record<string, string>>,
  account: string,
): { readonly bucket: string; readonly overrides: Readonly<Record<string, string>> } {
  const storage = storageTarget(dotEnv);
  if (storage.kind === 'none') return { bucket: '', overrides: {} };
  const { location } = storage;
  if (location.kind !== 's3') {
    throw new Error(
      'AW_STORAGE_URL in .env must be an s3:// URL: a Worker keeps nothing on disk and R2 is ' +
        'S3-compatible. Nothing was run.',
    );
  }
  return {
    bucket: location.bucket,
    overrides: {
      AW_STORAGE_URL: formatStorageUrl({
        ...location,
        endpoint: location.endpoint ?? `https://${account}.r2.cloudflarestorage.com`,
        region: location.region ?? 'auto',
      }),
    },
  };
}

export async function deployWithCloudflare(
  context: DeployContext,
  target: CloudflareTarget,
  projectEnv: Readonly<Record<string, string>>,
  apply: boolean,
): Promise<DeployOutcome> {
  const dotEnv = withoutIgnoredStorageSettings(context, projectEnv);
  // As on Vercel: old names alone used to place the store, so an apply with only them would quietly
  // run with no files, skills or session state.
  if (
    apply &&
    ignoredStorageVariables(projectEnv).length > 0 &&
    storageTarget(dotEnv).kind === 'none'
  ) {
    throw new Error(
      'AW_STORAGE_URL is empty in .env, and the old storage settings in it are ignored: the ' +
        'control plane would keep no files, skills or session state. Set AW_STORAGE_URL to the ' +
        's3:// URL of its R2 bucket and run again. Nothing was run.',
    );
  }
  const unset = [CLOUDFLARE_API_TOKEN_VARIABLE, CLOUDFLARE_ACCOUNT_ID_VARIABLE].filter(
    (name) => (context.env[name]?.trim() ?? '') === '',
  );
  const offline = !apply && unset.length > 0;
  const { account, subdomain, controlPlane } = offline
    ? offlineSettings(context, dotEnv)
    : readSettings(context, dotEnv);

  const cronSecret = required(dotEnv, CRON_SECRET_VARIABLE, 'the retention route secret');
  const workersDev = (worker: string) => `https://${worker}.${subdomain}.workers.dev`;
  const gatewayUrl = addressOf(
    dotEnv,
    'MODEL_GATEWAY_URL',
    target.gatewayWorkerName,
    workersDev(target.gatewayWorkerName),
  );
  const managerUrl = addressOf(
    dotEnv,
    'RUNNER_MANAGER_URL',
    target.managerWorkerName,
    workersDev(target.managerWorkerName),
  );
  const frontend = frontendDirectory(context);
  const frontendOrigin = frontend === null ? null : workersDev(target.frontendWorkerName);

  const webImage = dotEnv[ENV_IMAGE_KEYS.web]?.trim() ?? '';
  const driver = dotEnv['RUNTIME_DRIVER']?.trim() ?? '';
  const migration = apply ? readApplySettings(dotEnv) : {};
  const images = {
    web: registryImage(dotEnv, 'web', account),
    gateway: registryImage(dotEnv, 'gateway', account),
    runner: registryImage(dotEnv, 'runner', account),
  };

  const addresses: Secrets = [
    ['MODEL_GATEWAY_URL', gatewayUrl],
    ['RUNNER_MANAGER_URL', managerUrl],
    ...(frontendOrigin === null ? [] : [[FRONTEND_ORIGIN_VARIABLE, frontendOrigin] as const]),
  ];
  const r2 = r2Storage(dotEnv, account);
  const controlPlaneSecrets: Secrets = Object.entries({
    ...dotEnv,
    ...r2.overrides,
    ...awsCredentials(dotEnv),
  })
    .filter(([name, value]) => value.trim() !== '' && !NOT_PROJECT_VARIABLES.has(name))
    .filter(([name]) => !addresses.some(([address]) => address === name))
    .concat(toolHostVariables(dotEnv).map(([name, value]) => [name, value]))
    .concat(addresses.map(([name, value]) => [name, value]));
  // The gateway forwards the Builder's aw-control MCP calls to the control plane Worker's own
  // workers.dev origin, derived like the gateway's, never from `.env` or a request.
  const gatewaySecrets: Secrets = [
    ...gatewayVariables(dotEnv),
    ['GATEWAY_CONTROL_PLANE_ORIGIN', workersDev(target.controlPlaneWorkerName)],
  ];
  const managerSecrets: Secrets = [
    ...selected(managerEnvironment(dotEnv), [...MANAGER_VARIABLES, BRIDGE_URL_VARIABLE]),
    // E2B finds a session's sandbox again, so an idle-stopped manager keeps no table to lose (ADR-0126).
    ...(driver === 'external' ? [['RUNNER_MANAGER_STATELESS', 'true'] as const] : []),
    ...toolHostVariables(dotEnv),
    ['GATEWAY_PUBLIC_URL', gatewayUrl],
  ];
  // Exactly what retention-worker.mjs reads: least privilege for a retention-only Worker.
  const secrets: Secrets = [
    [CONTROL_PLANE_URL_VARIABLE, controlPlane],
    [CRON_SECRET_VARIABLE, cronSecret],
  ];

  const worker = ['--name', target.workerName, '--config', target.configFile];
  if (offline) {
    context.out(
      `${unset.join(' and ')} ${unset.length === 1 ? 'is' : 'are'} not set, so this plan reads ` +
        'nothing from Cloudflare: it lists what an apply does to an account that has none of it.\n',
    );
  }
  const { exists, registryListing } = offline
    ? { exists: false, registryListing: '' }
    : await readAccountState(context, worker);
  const imageList = [images.web, images.gateway, images.runner];
  const names = (list: Secrets) => list.map(([name]) => name).join(', ');
  context.out(
    `Cloudflare account ${account}: applying pushes to the Cloudflare registry the images it ` +
      'lacks, runs the database migrations once, then deploys the Workers below and uploads ' +
      'their secrets with their current values, one bulk call each.\n' +
      imageList
        .map(
          (image) =>
            `Image ${image.label} (${image.tag}): ` +
            `${inRegistry(image, registryListing) ? 'skip, already in the registry' : 'push'}.\n`,
        )
        .join('') +
      `Gateway Worker ${target.gatewayWorkerName} (${gatewayUrl}), configuration ` +
      `${target.gatewayConfigFile}: ${names(gatewaySecrets)}.\n` +
      `Runner manager Worker ${target.managerWorkerName} (${managerUrl}), configuration ` +
      `${target.managerConfigFile}, driver ${driver === '' ? 'unset' : driver}: ${names(managerSecrets)}.\n` +
      `Control plane Worker ${target.controlPlaneWorkerName}, configuration ` +
      `${target.controlPlaneConfigFile}: ${names(controlPlaneSecrets)}.\n` +
      (frontend === null || frontendOrigin === null
        ? 'No frontend Worker: AGENT_WORKSPACE_FRONTEND is not set, so the control plane has no ' +
          `${FRONTEND_ORIGIN_VARIABLE} and serves no browser origin.\n`
        : `Frontend Worker ${target.frontendWorkerName} (${frontendOrigin}), built from ${frontend} ` +
          `with ${FRONTEND_BASE_URL_VARIABLE}=${controlPlane.replace(/\/+$/u, '')}; the control ` +
          `plane's allowed origin is exactly ${frontendOrigin}.\n`) +
      `Cloudflare Worker ${target.workerName}: ` +
      (exists ? 'exists' : 'will be created') +
      `; secrets put with their current values: ${names(secrets)}. ` +
      `Retention Worker configuration: ${target.configFile}.\n`,
  );

  // ponytail: an existing Worker's configuration is not diffed; edit it and deploy with wrangler.
  // Secret values cannot be read back, so they are always put again (a rotation must land).
  if (!apply) return { changes: true, applied: false };

  const bucket = r2.bucket;
  if (bucket !== '') {
    // The S3 adapter does not create a bucket when the backend is explicit, as it is on Cloudflare.
    const info = await runStep(context, 'wrangler', ['r2', 'bucket', 'info', bucket], {
      show: false,
      accept: [0, 1],
    });
    if (info.status !== 0) {
      if (!BUCKET_NOT_FOUND.test(`${info.stdout}\n${info.stderr}`)) {
        context.err(info.stderr);
        throw new Error(
          `\`wrangler r2 bucket info ${bucket}\` failed (exit status ${String(info.status)}) and ` +
            'did not say the bucket is missing; its output is above. Nothing was applied.',
        );
      }
      await runStep(context, 'wrangler', ['r2', 'bucket', 'create', bucket], { show: true });
    }
  }
  // After the bucket check, so a token R2 denies stops before any image is pushed.
  await pushImages(context, imageList, registryListing);
  // Migrations before any Worker deploy: a failure leaves the live control plane on its schema (ADR-0127).
  await runStep(
    context,
    'docker',
    [
      'run',
      '--rm',
      ...Object.keys(migration).flatMap((name) => ['-e', name]),
      webImage,
      'sh',
      '-c',
      MIGRATE_AND_SEED,
    ],
    { show: true, env: migration },
  );
  // The gateway and the manager are up before the control plane that calls them.
  for (const part of [
    {
      name: target.gatewayWorkerName,
      configFile: target.gatewayConfigFile,
      image: images.gateway,
      secrets: gatewaySecrets,
    },
    {
      name: target.managerWorkerName,
      configFile: target.managerConfigFile,
      image: images.runner,
      secrets: managerSecrets,
    },
    {
      name: target.controlPlaneWorkerName,
      configFile: target.controlPlaneConfigFile,
      image: images.web,
      secrets: controlPlaneSecrets,
    },
  ]) {
    await withTemporaryConfiguration(
      path.basename(part.configFile),
      await registryConfiguration(part.configFile, part.image, part.name),
      async (file) => {
        await runStep(context, 'wrangler', ['deploy', '--config', file, '--name', part.name], {
          show: true,
          retry: afterUpload(context),
        });
        // The same validated copy: the rendered file alone is not a complete Wrangler configuration.
        await runStep(
          context,
          'wrangler',
          ['secret', 'bulk', '--name', part.name, '--config', file],
          {
            show: false,
            input: JSON.stringify(Object.fromEntries(part.secrets)),
            retry: afterUpload(context),
          },
        );
      },
    );
  }
  if (frontend !== null) {
    // The build runs inside `wrangler deploy` (the configuration's `build`) and reads the base URL
    // from the child's environment.
    await withTemporaryConfiguration(
      'frontend.wrangler.jsonc',
      cloudflareFrontendConfiguration(frontend, path.join(frontend, 'dist')),
      (file) =>
        runStep(
          context,
          'wrangler',
          ['deploy', '--config', file, '--name', target.frontendWorkerName],
          {
            show: true,
            env: { [FRONTEND_BASE_URL_VARIABLE]: controlPlane.replace(/\/+$/u, '') },
            retry: afterUpload(context),
          },
        ),
    );
  }
  if (!exists) {
    await runStep(
      context,
      'wrangler',
      ['deploy', '--config', target.configFile, '--name', target.workerName],
      { show: true, retry: afterUpload(context) },
    );
  }
  for (const [name, value] of secrets) {
    await runStep(context, 'wrangler', ['secret', 'put', name, ...worker], {
      show: false,
      input: value,
      ...(exists ? {} : { retry: afterUpload(context) }),
    });
  }
  await waitForWorker(
    context,
    'control plane',
    target.controlPlaneWorkerName,
    `${controlPlane.replace(/\/+$/u, '')}/setup`,
  );
  // setup tests the runtime through the manager right after deploy, and its container starts as slowly.
  await waitForWorker(
    context,
    'runner manager',
    target.managerWorkerName,
    `${managerUrl.replace(/\/+$/u, '')}/healthz`,
  );
  return { changes: true, applied: true };
}
