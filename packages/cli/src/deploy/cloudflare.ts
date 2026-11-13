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
import path from 'node:path';
import { cloudflareFrontendConfiguration } from '../render/cloudflare.ts';
import { prepareCloudflare, type CloudflarePlan } from './cloudflare-plan.ts';
import { waitForWorker } from './cloudflare-readiness.ts';
import {
  inRegistry,
  pushImages,
  registryConfiguration,
  withTemporaryConfiguration,
} from './cloudflare-registry.ts';
import { runStep, type DeployContext, type DeployOutcome } from './steps.ts';
import type { DeployTarget } from './targets.ts';
import {
  FRONTEND_BASE_URL_VARIABLE,
  FRONTEND_ORIGIN_VARIABLE,
  MIGRATE_AND_SEED,
} from './vercel.ts';
export { CLOUDFLARE_API_TOKEN_VARIABLE } from './cloudflare-settings.ts';
type Secrets = readonly (readonly [string, string])[];

type CloudflareTarget = Extract<DeployTarget, { kind: 'cloudflare' }>;

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

export async function deployWithCloudflare(
  context: DeployContext,
  target: CloudflareTarget,
  projectEnv: Readonly<Record<string, string>>,
  apply: boolean,
): Promise<DeployOutcome> {
  const plan = prepareCloudflare(context, target, projectEnv, apply);
  const { images, r2, unset, offline } = plan;
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
  reportPlan(context, target, plan, { exists, registryListing });

  // ponytail: an existing Worker's configuration is not diffed; edit it and deploy with wrangler.
  // Secret values cannot be read back, so they are always put again (a rotation must land).
  if (!apply) return { changes: true, applied: false };

  await ensureBucket(context, r2.bucket);
  // After the bucket check, so a token R2 denies stops before any image is pushed.
  await pushImages(context, imageList, registryListing);
  await migrateDatabase(context, plan);
  await deployContainerWorkers(context, target, plan);
  await deployFrontend(context, target, plan);
  await deployRetentionWorker(context, target, { exists, secrets: plan.secrets });
  await waitForDeployment(context, target, plan);
  return { changes: true, applied: true };
}

function reportPlan(
  context: DeployContext,
  target: CloudflareTarget,
  plan: CloudflarePlan,
  state: { exists: boolean; registryListing: string },
): void {
  const {
    account,
    controlPlane,
    gatewayUrl,
    managerUrl,
    frontend,
    frontendOrigin,
    driver,
    images,
    controlPlaneSecrets,
    gatewaySecrets,
    managerSecrets,
    secrets,
  } = plan;
  const { exists, registryListing } = state;
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
}

async function ensureBucket(context: DeployContext, bucket: string): Promise<void> {
  const BUCKET_NOT_FOUND = /not found|does not exist|10006/iu;
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
}

async function deployContainerWorkers(
  context: DeployContext,
  target: CloudflareTarget,
  plan: CloudflarePlan,
): Promise<void> {
  const { images, gatewaySecrets, managerSecrets, controlPlaneSecrets } = plan;
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
}

async function deployFrontend(
  context: DeployContext,
  target: CloudflareTarget,
  plan: CloudflarePlan,
): Promise<void> {
  const { frontend, controlPlane } = plan;
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
}

async function migrateDatabase(context: DeployContext, plan: CloudflarePlan): Promise<void> {
  const { migration, webImage } = plan;
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
}

async function deployRetentionWorker(
  context: DeployContext,
  target: CloudflareTarget,
  state: { exists: boolean; secrets: Secrets },
): Promise<void> {
  const { exists, secrets } = state;
  const worker = ['--name', target.workerName, '--config', target.configFile];
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
}

async function waitForDeployment(
  context: DeployContext,
  target: CloudflareTarget,
  plan: CloudflarePlan,
): Promise<void> {
  const { controlPlane, managerUrl } = plan;
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
}
