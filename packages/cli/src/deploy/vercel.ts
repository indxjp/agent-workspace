/**
 * `deploy` for a Vercel target: the Vercel CLI (ADR-0094, ADR-0120 clauses 7 and 8).
 *
 * A deployment is up to four Vercel projects (ADR-0126): the control plane (`<name>`), the model
 * gateway (`<name>-gateway`), the runner manager (`<name>-manager`) and, when the project has a
 * `web/` frontend, that frontend (`<name>-web`). Each holds only the variables it needs: the
 * master key never reaches the manager or the frontend, and the manager's provider keys are never
 * stored at all (ADR-0120 LC6).
 *
 * On apply it configures every project and its production environment variables, runs the
 * database migrations once, and only then runs `vercel deploy` for each, gateway and manager
 * first. The migrations are a deploy step and
 * not a function (ADR-0120 clause 7): Functions never run the web image's `CMD`, and a cold start
 * must not migrate. They run the web image's own `migrate.js` and `seed.js`, the entry
 * `compose.yaml`'s `migrate` service uses, under the same Postgres advisory lock, so two deploys
 * at once are safe. A failing migration stops before `vercel deploy`, so the live deployment
 * keeps serving the schema it has.
 *
 * The token is read from the environment and reaches the CLI only through the child's
 * environment (`VERCEL_TOKEN`); it is never an argument, which `runStep` echoes and the process
 * list shows. A secret's value reaches `vercel env add` on stdin, and `DATABASE_URL` reaches the
 * migration container through the `docker` child's environment (`-e NAME` names it in argv, never
 * its value), for the same reason.
 *
 * Vendor facts, checked 2026-10-09 (Vercel CLI 63.1.0) against
 * https://vercel.com/docs/cli/global-options (the CLI reads `VERCEL_TOKEN`, `VERCEL_ORG_ID` and
 * `VERCEL_PROJECT_ID`; `--scope` takes a team slug or id; `--local-config` names the `vercel.json`
 * to use), https://vercel.com/docs/cli/project
 * (`project add <name>`, `project inspect <name>`), https://vercel.com/docs/cli/env (`env ls
 * [environment]`, `env add <name> <environment>` reads the value from stdin, `--sensitive`,
 * `--no-sensitive`, `--yes`) and https://vercel.com/docs/cli/deploy (`deploy [path]`, `--prod`,
 * `--yes`, `--archive=tgz`; `--cwd` is a global option; the deployment URL is the one line on stdout, the per-deployment URL and not the
 * project's production domain) and https://vercel.com/docs/cli/inspect (`inspect <deployment
 * url>`; its output format is not documented) and https://vercel.com/docs/cli/api (`api
 * <endpoint> -X <method> --input -` sends an authenticated REST request with the CLI's own
 * credentials and reads the body from stdin; `PATCH /v9/projects/{idOrName}` takes `rootDirectory`
 * and `sourceFilesOutsideRootDirectory`). None of this has run against a real account yet:
 * that is the live lane's job (issue #830, AC4).
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { ToolResult } from './runner.ts';
import { runStep, type DeployContext, type DeployOutcome } from './steps.ts';
import type { DeployTarget } from './targets.ts';
import {
  assertStageable,
  removeStaged,
  stageDirectory,
  stagePlatform,
  writeFunctionEntry,
} from './vercel-upload.ts';
import { composeProjectName, ENV_IMAGE_KEYS, ENV_VERSION_KEY } from '../render/env.ts';
import { VERCEL_PARTS } from '../render/vercel.ts';

type VercelTarget = Extract<DeployTarget, { kind: 'vercel' }>;

export const VERCEL_TOKEN_VARIABLE = 'VERCEL_TOKEN';
const VERCEL_TEAM_ID_VARIABLE = 'VERCEL_TEAM_ID';
/** The project's own `web/` directory, set by `aw deploy`; absent when the project has no frontend. */
const FRONTEND_VARIABLE = 'AGENT_WORKSPACE_FRONTEND';
/** The project's name, set by `aw deploy`; a directory deploy names the project after its directory. */
const PROJECT_NAME_VARIABLE = 'AGENT_WORKSPACE_PROJECT_NAME';
/** The control plane's public URL, set by `aw deploy` from the project file's `url`. */
const CONTROL_PLANE_URL_VARIABLE = 'CONTROL_PLANE_URL';
/** The variable a Vite frontend reads the control plane's address from. */
export const FRONTEND_BASE_URL_VARIABLE = 'VITE_AW_BASE_URL';
/** The checkout of the platform `vercel deploy` uploads; the control plane project's Root Directory is `apps/web`, which `deploy` sets. */
const VERCEL_SOURCE_VARIABLE = 'AGENT_WORKSPACE_SOURCE';

/** The package the control plane project builds; the other parts' packages are in `VERCEL_PARTS`. */
const CONTROL_PLANE_PACKAGE = 'apps/web';

/** The package a rendered part builds: the one its `--filter` names. */
function platformPackage(part: 'gateway' | 'manager'): string {
  const filter = VERCEL_PARTS.find((candidate) => candidate.part === part)?.filter;
  if (filter === undefined || filter === null) throw new Error(`No Vercel part named ${part}.`);
  return filter.replace(/^\.\//u, '');
}

const ENVIRONMENT = 'production';
/** The control plane's variable for its own frontend's origin, merged into surfaces' allowedOrigins (ADR-0128). */
export const FRONTEND_ORIGIN_VARIABLE = 'AW_FRONTEND_ORIGIN';

/**
 * `.env` keys that mean nothing on Vercel: Compose's own, and the image pins. The runtime image key
 * is not one: the control plane reads it as its engine catalogue (ADR-0073 D2), never to start a
 * container, and without it no engine is installed, so setup's runtime test probes with no engine.
 * The two sandbox image keys are the manager's alone: each replaces the runtime image there.
 */
export const NOT_PROJECT_VARIABLES: ReadonlySet<string> = new Set([
  'COMPOSE_PROJECT_NAME',
  'COMPOSE_PROFILES',
  'DOCKER_GID',
  'PORT',
  'E2B_RUNTIME_TEMPLATE',
  // Rendered below, from the driver and the template; never copied from `.env` as it stands.
  'E2B_TOOL_HOST_TEMPLATE',
  'AGENT_WORKSPACE_TOOL_HOST_IMAGE',
  'VERCEL_SANDBOX_RUNTIME_IMAGE',
  ENV_VERSION_KEY,
  ...Object.values(ENV_IMAGE_KEYS).filter((key) => key !== ENV_IMAGE_KEYS.runtime),
]);

/**
 * Where a Vercel control plane keeps the runtime verifications setup records. A function can write
 * only below `/tmp`, so the production default (`/var/lib/...`) cannot be created there and setup's
 * runtime test fails after the manager has already answered. `/tmp` lasts as long as the function
 * instance, the same lifetime as the in-memory fallback a read-only filesystem gets.
 */
const VERIFICATION_FILE_VARIABLE = 'AW_RUNTIME_VERIFICATION_FILE';
const VERCEL_VERIFICATION_FILE = '/tmp/agent-workspace/runtime-verifications.json';

/**
 * The variables Vercel stores as Sensitive: write-only after creation (ADR-0120 clause 8). The
 * master key is the one that matters most; the rest are every other credential `.env` renders.
 */
const SENSITIVE_VARIABLES: ReadonlySet<string> = new Set([
  'MASTER_ENCRYPTION_KEY',
  'SESSION_SECRET',
  'GATEWAY_TOKEN_SECRET',
  'CRON_SECRET',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'RUNNER_MANAGER_TOKEN',
  'OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'DATABASE_URL',
  'OIDC_CLIENT_SECRET',
]);

/** What the gateway reads: the database, the secrets service, its token secret and its rates. */
const GATEWAY_VARIABLES = [
  'DATABASE_URL',
  'MASTER_KEY_PROVIDER',
  'MASTER_ENCRYPTION_KEY',
  'AZURE_KEY_VAULT_URL',
  'AZURE_MASTER_KEY_SECRET_NAME',
  'GCP_MASTER_KEY_SECRET',
  'GATEWAY_TOKEN_SECRET',
  'GATEWAY_PRICING_JSON',
] as const;

/** What the manager reads from `.env`; the rest of its configuration is computed below. */
export const MANAGER_VARIABLES = [
  'RUNNER_MANAGER_TOKEN',
  'RUNTIME_DRIVER',
  ENV_IMAGE_KEYS.runtime,
  'VERCEL_PLAN_TIER',
  'EXTERNAL_PROVIDER',
  'E2B_PLAN_TIER',
  // ADR-0132's backstop for a tool sandbox; the manager defaults it when unset.
  'AGENT_WORKSPACE_TOOL_SANDBOX_TIMEOUT_SECONDS',
] as const;

// The same pattern as `BUILD_ID_PIN` in packages/runtime/src/external/e2b.ts, which the CLI cannot import.
const E2B_TEMPLATE_PIN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * The E2B template an `external` manager runs, `<template>:<build_id>`. `render` keeps the runtime
 * image key an OCI digest, which E2B cannot run, so the template has its own `.env` key.
 */
const E2B_TEMPLATE_VARIABLE = 'E2B_RUNTIME_TEMPLATE';
/** The E2B template of the tool host, `<template>:<build_id>`: optional, and without it code tools stay refused. */
const TOOL_HOST_TEMPLATE_VARIABLE = 'E2B_TOOL_HOST_TEMPLATE';

/**
 * The production manager (`NODE_ENV=production`) refuses an `external` runtime whose image is not an
 * E2B template pinned `<template>:<build_id>` (ADR-0120 LC2) and exits 1 at start, which the host
 * reports as an unexplained crash. Refused here, by key and never by value, before anything runs.
 */
export function assertE2bTemplatePinned(dotEnv: Readonly<Record<string, string>>): void {
  if (dotEnv['RUNTIME_DRIVER']?.trim() !== 'external') return;
  const toolHost = dotEnv[TOOL_HOST_TEMPLATE_VARIABLE]?.trim() ?? '';
  for (const [name, value, optional] of [
    [E2B_TEMPLATE_VARIABLE, dotEnv[E2B_TEMPLATE_VARIABLE]?.trim() ?? '', false],
    [TOOL_HOST_TEMPLATE_VARIABLE, toolHost, true],
  ] as const) {
    if ((optional && value === '') || E2B_TEMPLATE_PIN.test(value)) continue;
    throw new Error(
      `${name} must be an E2B template pinned as <template>:<build_id> when ` +
        'RUNTIME_DRIVER is external (ADR-0120 LC2): the runner manager refuses an image digest at ' +
        'start and exits 1. Set it in .env and run again. Nothing was run.',
    );
  }
}

/**
 * The flag that tells the control plane and the manager a code tool has a host (ADR-0118). Only an
 * `external` (E2B) runtime can run one on a hosted deployment: `vercel-sandbox` and
 * `cloudflare-sandbox` render nothing, so a push that carries a code tool is still refused up front.
 */
export function toolHostVariables(
  dotEnv: Readonly<Record<string, string>>,
): readonly (readonly [string, string])[] {
  const template = dotEnv[TOOL_HOST_TEMPLATE_VARIABLE]?.trim() ?? '';
  return dotEnv['RUNTIME_DRIVER']?.trim() === 'external' && template !== ''
    ? [['AGENT_WORKSPACE_TOOL_HOST_IMAGE', template]]
    : [];
}

/**
 * What the gateway is given. With a tool host it also holds the manager token: the manager's tool
 * sandbox route requires it beside the run token (ADR-0132).
 */
export function gatewayVariables(
  dotEnv: Readonly<Record<string, string>>,
): readonly (readonly [string, string])[] {
  return [
    ...selected(dotEnv, GATEWAY_VARIABLES),
    ...(toolHostVariables(dotEnv).length === 0 ? [] : selected(dotEnv, ['RUNNER_MANAGER_TOKEN'])),
  ];
}

/**
 * The runtime image a `vercel-sandbox` manager runs: a Vercel Container Registry reference
 * `<team-slug>/<project>/<repository>@sha256:<digest>` in the manager's own project (ADR-0120 LC2).
 * A registry is project-scoped and `render` keeps the runtime image key an image any registry can
 * serve, which Vercel Sandbox cannot run, so the reference has its own `.env` key.
 */
const VERCEL_SANDBOX_IMAGE_VARIABLE = 'VERCEL_SANDBOX_RUNTIME_IMAGE';
const VERCEL_SANDBOX_IMAGE_PIN =
  /^[a-z0-9][a-z0-9-]{0,47}\/[^/@\s]+\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u;

/**
 * A `vercel-sandbox` manager whose image is not in its own project's registry starts, then answers
 * every sandbox create with the provider's refusal (a 500 to the caller). Refused here, by key and
 * never by value, before anything runs.
 */
function assertVercelSandboxImagePinned(
  dotEnv: Readonly<Record<string, string>>,
  projectName: string,
): void {
  if (dotEnv['RUNTIME_DRIVER']?.trim() !== 'vercel-sandbox') return;
  const reference = dotEnv[VERCEL_SANDBOX_IMAGE_VARIABLE]?.trim() ?? '';
  if (
    VERCEL_SANDBOX_IMAGE_PIN.test(reference) &&
    reference.split('/')[1] === `${projectName}-manager`
  ) {
    return;
  }
  throw new Error(
    `${VERCEL_SANDBOX_IMAGE_VARIABLE} must be <team-slug>/${projectName}-manager/<repository>@sha256:<digest> ` +
      'when RUNTIME_DRIVER is vercel-sandbox (ADR-0120 LC2): Vercel Sandbox runs only an image in ' +
      "the manager project's Vercel Container Registry and refuses any other. Push the runtime " +
      'image to vcr.vercel.com, set the reference in .env and run again. Nothing was run.',
  );
}

/**
 * `.env` as the manager reads it: an `external` runtime runs the E2B template and a `vercel-sandbox`
 * runtime its Vercel Container Registry reference, not the digest.
 */
export function managerEnvironment(
  dotEnv: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const driver = dotEnv['RUNTIME_DRIVER']?.trim();
  const image =
    driver === 'external'
      ? dotEnv[E2B_TEMPLATE_VARIABLE]?.trim()
      : driver === 'vercel-sandbox'
        ? dotEnv[VERCEL_SANDBOX_IMAGE_VARIABLE]?.trim()
        : undefined;
  return image === undefined || image === ''
    ? dotEnv
    : { ...dotEnv, [ENV_IMAGE_KEYS.runtime]: image };
}

/** The `.env` values the one-shot migration container needs, by name. Seed reads the last four. */
export const MIGRATION_VARIABLES = [
  'DATABASE_URL',
  'BOOTSTRAP_ADMIN',
  'WORKSPACE_SLUG',
  'WORKSPACE_NAME',
  'BOOTSTRAP_ADMIN_NAME',
] as const;

export const MIGRATE_AND_SEED =
  'node /srv/packages/core/dist/db/migrate.js && node /srv/packages/core/dist/db/seed.js';

const RELEASE_MANIFEST = path.join('packages', 'cli', 'src', 'release-images.json');

/**
 * The release a platform checkout is at, from the manifest the images are published from, or why
 * it is unknown. Only the `version` field is read, and only as a string.
 */
function checkoutVersion(source: string): string | null {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(source, RELEASE_MANIFEST), 'utf8'));
    const version =
      typeof manifest === 'object' && manifest !== null
        ? (manifest as Record<string, unknown>)['version']
        : undefined;
    return typeof version === 'string' && version !== '' ? version : null;
  } catch {
    return null;
  }
}

/**
 * The migrations run from `WEB_IMAGE` and the code from the checkout, so both must be one release.
 * `AGENT_WORKSPACE_VERSION` in `.env` is the release the image was resolved for; the checkout's
 * `release-images.json` is the release it is at. Anything but equal is refused by name.
 */
function assertOneRelease(source: string, dotEnv: Readonly<Record<string, string>>): void {
  const rendered = dotEnv[ENV_VERSION_KEY]?.trim() ?? '';
  if (rendered === '') {
    throw new Error(
      `${ENV_VERSION_KEY} is empty in .env: it names the release ${ENV_IMAGE_KEYS.web} was ` +
        'resolved for, and the checkout cannot be matched to the image without it. Run ' +
        '`create-agent-workspace` again or add the line. Nothing was run.',
    );
  }
  const checkout = checkoutVersion(source);
  if (checkout === null) {
    throw new Error(
      `${VERCEL_SOURCE_VARIABLE} is ${source}, which has no readable ${RELEASE_MANIFEST}: ` +
        'point it at a platform checkout. Nothing was run.',
    );
  }
  if (checkout !== rendered) {
    throw new Error(
      `${VERCEL_SOURCE_VARIABLE} is at ${checkout} but ${ENV_IMAGE_KEYS.web} was rendered for ` +
        `${rendered} (${ENV_VERSION_KEY}); check out release ${rendered}, or pin the images of ` +
        `${checkout} and set ${ENV_VERSION_KEY} to it. Nothing was run.`,
    );
  }
}

/** The value of a required environment variable, or a refusal that names it. */
function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
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

/** The names `vercel env ls` lists: the first column of each row. */
function listedNames(listing: string): ReadonlySet<string> {
  return new Set(
    listing
      .split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u)[0] ?? '')
      .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)),
  );
}

// Vercel CLI 63.1.0 answers `Error: There is no project for "<name>"` with exit 1 (observed in the
// lightweight-journey run 37897406759, 2026-10-09); `project inspect` has no structured form, so
// the wording is matched.
const PROJECT_NOT_FOUND =
  /not found|does not exist|no such project|there is no project for "[^"\r\n]*"/iu;

async function projectExists(
  context: DeployContext,
  project: string,
  team: string,
): Promise<boolean> {
  const result: ToolResult = await runStep(
    context,
    'vercel',
    ['project', 'inspect', project, '--scope', team],
    { show: false, accept: [0, 1] },
  );
  if (result.status === 0) return true;
  if (PROJECT_NOT_FOUND.test(`${result.stdout}\n${result.stderr}`)) return false;
  // Anything else (a rejected token, no network) is not "the project is missing".
  context.err(result.stderr);
  throw new Error(
    `\`vercel project inspect\` failed (exit status ${String(result.status)}) and did not say the ` +
      'project is missing; its output is above. Nothing was applied.',
  );
}

const linkedTo = (team: string, project: string) => ({
  VERCEL_ORG_ID: team,
  VERCEL_PROJECT_ID: project,
});

/** One Vercel project of the deployment, with the variables it alone holds. */
interface Part {
  readonly label: 'control plane' | 'gateway' | 'manager' | 'frontend';
  readonly project: string;
  readonly settingsFile: string;
  /**
   * What `vercel deploy` uploads, pruned: a platform package with the workspace packages it
   * depends on, or the project's own directory.
   */
  readonly upload: { readonly platformPackage: string } | { readonly directory: string };
  /**
   * The project's Root Directory, set on every apply: a path, or `null` for the upload root. Absent
   * for the frontend, which uploads its own directory and keeps whatever the project has.
   */
  readonly rootDirectory?: string | null;
  /** Whether the project is one function, the package's compiled `dist/api/index.js` re-exported at the upload root. */
  readonly functionEntry?: boolean;
  readonly variables: readonly (readonly [string, string])[];
}

interface PartState {
  readonly exists: boolean;
  readonly missing: readonly (readonly [string, string])[];
}

/** The production address a project answers at before a custom domain: Vercel's project domain. */
function vercelProductionUrl(project: string): string {
  return `https://${project}.vercel.app`;
}

/** An address from `.env` (a custom domain), or the project's own production URL. */
export function addressOf(
  dotEnv: Readonly<Record<string, string>>,
  name: string,
  project: string,
  fallback: string = vercelProductionUrl(project),
): string {
  const given = dotEnv[name]?.trim() ?? '';
  if (given === '') return fallback;
  let origin: string | null;
  try {
    const url = new URL(given);
    origin = url.protocol === 'https:' && url.pathname === '/' ? url.origin : null;
  } catch {
    origin = null;
  }
  if (origin === null) {
    throw new Error(`${name} is ${given} in .env: it must be an https origin. Nothing was run.`);
  }
  return origin;
}

/**
 * The object storage key pair under the names the web server's S3 adapter reads. Compose and Helm
 * map it the same way; an explicit `AWS_*` in `.env` wins. Empty when `.env` holds neither.
 */
export function awsCredentials(dotEnv: Readonly<Record<string, string>>): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID:
      dotEnv['AWS_ACCESS_KEY_ID']?.trim() || dotEnv['OBJECT_STORAGE_ACCESS_KEY_ID'] || '',
    AWS_SECRET_ACCESS_KEY:
      dotEnv['AWS_SECRET_ACCESS_KEY']?.trim() || dotEnv['OBJECT_STORAGE_SECRET_ACCESS_KEY'] || '',
  };
}

/** The variables `names` select from `.env`, leaving out the empty ones. */
export function selected(
  dotEnv: Readonly<Record<string, string>>,
  names: readonly string[],
): readonly (readonly [string, string])[] {
  return names.flatMap((name): [string, string][] => {
    const value = dotEnv[name]?.trim() ?? '';
    return value === '' ? [] : [[name, value]];
  });
}

/** The frontend directory `aw deploy` named, or `null`; a name that is not a Vite project is refused. */
export function frontendDirectory(context: DeployContext): string | null {
  const given = context.env[FRONTEND_VARIABLE]?.trim() ?? '';
  if (given === '') return null;
  const directory = path.resolve(context.directory, given);
  if (
    statSync(path.join(directory, 'package.json'), { throwIfNoEntry: false })?.isFile() !== true
  ) {
    throw new Error(
      `${FRONTEND_VARIABLE} is ${directory}, which has no package.json: point it at the project's ` +
        'web/ directory. Nothing was run.',
    );
  }
  return directory;
}

function partsOf(
  context: DeployContext,
  target: VercelTarget,
  team: string,
  dotEnv: Readonly<Record<string, string>>,
): { readonly parts: readonly Part[]; readonly addresses: ReadonlyMap<string, string> } {
  const settings = (fileName: string) => path.join(path.dirname(target.settingsFile), fileName);
  const gatewayProject = `${target.projectName}-gateway`;
  const managerProject = `${target.projectName}-manager`;
  const gatewayUrl = addressOf(dotEnv, 'MODEL_GATEWAY_URL', gatewayProject);
  const managerUrl = addressOf(dotEnv, 'RUNNER_MANAGER_URL', managerProject);

  const addresses = new Map([
    ['MODEL_GATEWAY_URL', gatewayUrl],
    ['RUNNER_MANAGER_URL', managerUrl],
  ]);
  const controlPlane = Object.entries({ ...dotEnv, ...awsCredentials(dotEnv) })
    .filter(([name, value]) => value !== '' && !NOT_PROJECT_VARIABLES.has(name))
    .filter(([name]) => !addresses.has(name))
    .map(([name, value]): [string, string] => [name, value.trim()]);
  const parts: Part[] = [
    {
      label: 'gateway',
      project: gatewayProject,
      settingsFile: settings('gateway.json'),
      upload: { platformPackage: platformPackage('gateway') },
      rootDirectory: null,
      functionEntry: true,
      variables: gatewayVariables(dotEnv),
    },
    {
      label: 'manager',
      project: managerProject,
      settingsFile: settings('manager.json'),
      upload: { platformPackage: platformPackage('manager') },
      rootDirectory: null,
      functionEntry: true,
      variables: [
        ...selected(managerEnvironment(dotEnv), MANAGER_VARIABLES),
        ...toolHostVariables(dotEnv),
        ['RUNNER_MANAGER_STATELESS', 'true'],
        ['GATEWAY_PUBLIC_URL', gatewayUrl],
        ...(dotEnv['RUNTIME_DRIVER']?.trim() === 'vercel-sandbox'
          ? [['AW_VERCEL_TEAM_ID', team] as const]
          : []),
      ],
    },
    {
      label: 'control plane',
      project: target.projectName,
      settingsFile: target.settingsFile,
      upload: { platformPackage: CONTROL_PLANE_PACKAGE },
      rootDirectory: CONTROL_PLANE_PACKAGE,
      variables: [
        ...controlPlane,
        ...(dotEnv[VERIFICATION_FILE_VARIABLE]?.trim()
          ? []
          : [[VERIFICATION_FILE_VARIABLE, VERCEL_VERIFICATION_FILE] as const]),
        ...toolHostVariables(dotEnv),
        ...addresses,
      ],
    },
  ];

  const frontend = frontendDirectory(context);
  if (frontend !== null) {
    parts.push({
      label: 'frontend',
      project: `${target.projectName}-web`,
      settingsFile: settings('frontend.json'),
      upload: { directory: frontend },
      variables: [
        [
          FRONTEND_BASE_URL_VARIABLE,
          requiredEnvironment(
            context.env,
            CONTROL_PLANE_URL_VARIABLE,
            "the control plane's public address (aw deploy sets it from the project file's url)",
          ).replace(/\/+$/u, ''),
        ],
      ],
    });
  }
  return { parts, addresses };
}

/**
 * A Vercel function has no writable disk to keep skills, files and session state on, so the
 * control plane needs an S3-compatible bucket and its key pair (R2, S3, Tigris...). Without them
 * every `/api/skills*` route answers 503 `skills_runtime_not_configured` and `aw push` fails.
 * Vercel Blob is not the object store (ADR-0120 LC8).
 */
function assertObjectStorageConfigured(dotEnv: Readonly<Record<string, string>>): void {
  const backend = dotEnv['OBJECT_STORAGE_BACKEND']?.trim() ?? '';
  if (backend !== '' && backend !== 's3') return;
  const keys = awsCredentials(dotEnv);
  for (const [name, value] of [
    ['OBJECT_STORAGE_BUCKET', dotEnv['OBJECT_STORAGE_BUCKET']],
    ['OBJECT_STORAGE_ACCESS_KEY_ID', keys['AWS_ACCESS_KEY_ID']],
    ['OBJECT_STORAGE_SECRET_ACCESS_KEY', keys['AWS_SECRET_ACCESS_KEY']],
  ] as const) {
    if ((value ?? '').trim() === '') {
      throw new Error(
        `${name} is empty in .env: a Vercel function keeps nothing on disk, so the control plane ` +
          'needs an S3-compatible bucket (set OBJECT_STORAGE_ENDPOINT for a non-AWS store such as ' +
          'R2) and its key pair, and without them skills, files and session state answer 503 ' +
          '(and aw push fails). Create the bucket, set the value and run again. Nothing was run.',
      );
    }
  }
}

/** Staging happens part by part during the apply; what it would refuse is refused before it. */
async function assertPartsStageable(source: string | null, parts: readonly Part[]): Promise<void> {
  if (source === null) return;
  for (const { upload, functionEntry } of parts) {
    if ('platformPackage' in upload) {
      await assertStageable(source, upload.platformPackage, {
        functionEntry: functionEntry === true,
      });
    }
  }
}

async function inspectPart(context: DeployContext, part: Part, team: string): Promise<PartState> {
  const exists = await projectExists(context, part.project, team);
  const present = exists
    ? listedNames(
        (
          await runStep(context, 'vercel', ['env', 'ls', ENVIRONMENT, '--scope', team], {
            show: false,
            env: linkedTo(team, part.project),
          })
        ).stdout,
      )
    : new Set<string>();
  const missing = part.variables.filter(([name]) => !present.has(name));
  const kept = part.variables.filter(([name]) => present.has(name)).map(([name]) => name);

  context.out(
    `Vercel project ${part.project} (${part.label}, team ${team}): ` +
      (exists ? 'exists' : 'will be created') +
      `; ${String(missing.length)} of ${String(part.variables.length)} ${ENVIRONMENT} ` +
      'variable(s) to add' +
      (missing.length === 0 ? '.\n' : `: ${missing.map(([name]) => name).join(', ')}.\n`),
  );
  // Vercel never returns a Sensitive value, so a changed value cannot be told from an unchanged
  // one. Say so rather than keep a stale secret without a word.
  if (kept.length > 0) {
    context.out(
      `Left as they are in ${part.project} (their values are not compared): ${kept.join(', ')}.\n` +
        `To change one, remove it with \`vercel env rm <NAME> production\` in ${part.project}, then deploy again.\n`,
    );
  }
  return { exists, missing };
}

async function configurePart(
  context: DeployContext,
  part: Part,
  team: string,
  state: PartState,
): Promise<void> {
  if (!state.exists) {
    await runStep(context, 'vercel', ['project', 'add', part.project, '--scope', team], {
      show: true,
    });
  }
  // Before the variables, so a refused request leaves none of them written.
  await setRootDirectory(context, part, team);
  for (const [name, value] of state.missing) {
    await runStep(
      context,
      'vercel',
      [
        'env',
        'add',
        name,
        ENVIRONMENT,
        SENSITIVE_VARIABLES.has(name) ? '--sensitive' : '--no-sensitive',
        '--yes',
        '--scope',
        team,
      ],
      { show: false, input: value, env: linkedTo(team, part.project) },
    );
  }
}

/**
 * Sets the project's Root Directory through the Vercel CLI's own authenticated request, so the
 * token stays in the child's environment. `sourceFilesOutsideRootDirectory` lets `apps/web` build
 * with the workspace packages beside it. Idempotent, and it replaces a value set by hand.
 */
async function setRootDirectory(context: DeployContext, part: Part, team: string): Promise<void> {
  if (part.rootDirectory === undefined) return;
  const body =
    part.rootDirectory === null
      ? { rootDirectory: null }
      : { rootDirectory: part.rootDirectory, sourceFilesOutsideRootDirectory: true };
  await runStep(
    context,
    'vercel',
    [
      'api',
      `/v9/projects/${part.project}?teamId=${encodeURIComponent(team)}`,
      '-X',
      'PATCH',
      '--input',
      '-',
      '--scope',
      team,
    ],
    { show: false, input: JSON.stringify(body), env: linkedTo(team, part.project) },
  );
}

/** What a plan says of the Root Directory each platform project will be given. */
function rootDirectoryNote(parts: readonly Part[]): string {
  return parts
    .filter(({ rootDirectory }) => rootDirectory !== undefined)
    .map(
      ({ project, rootDirectory }) =>
        `Root Directory of ${project} will be set to ${rootDirectory ?? 'the upload root'}.\n`,
    )
    .join('');
}

/** What a plan says of the frontend's origin, or nothing when the project has no frontend. */
function frontendNote(parts: readonly Part[]): string {
  return parts.some((part) => part.label === 'frontend')
    ? ` The frontend is deployed before the control plane, and its origin is set as ${FRONTEND_ORIGIN_VARIABLE} there once Vercel lists it for the deployment.`
    : '';
}

/** The deployment URL `vercel deploy` printed: its last stdout line, when that is a bare https vercel.app origin. */
function deploymentUrlOf(stdout: string): string | null {
  const line = stdout.trim().split(/\r?\n/u).at(-1)?.trim() ?? '';
  try {
    const url = new URL(line);
    const bare = url.origin === line && url.username === '' && url.password === '';
    return url.protocol === 'https:' && bare && url.hostname.endsWith('.vercel.app') ? line : null;
  } catch {
    return null;
  }
}

/**
 * Tells the control plane its frontend's origin, once Vercel itself lists it for the deployment
 * just made (ADR-0128). The origin is the frontend project's production domain, known from its
 * name, and is trusted only after `vercel inspect` of the new deployment names it, so a
 * `<name>-web.vercel.app` that belongs to someone else is never written. `inspect`'s output is
 * undocumented, so a change in it fails closed: nothing is written and the operator is told to
 * list the origin by hand. The variable goes through `inspectPart` and `configurePart` like every
 * other one, so a re-deploy leaves an existing value as it is.
 */
async function allowFrontendOrigin(
  context: DeployContext,
  frontend: Part,
  controlPlane: Part,
  team: string,
  deployed: ToolResult,
): Promise<void> {
  const origin = vercelProductionUrl(frontend.project);
  const deployment = deploymentUrlOf(deployed.stdout);
  let confirmed = false;
  if (deployment !== null) {
    const inspected = await runStep(context, 'vercel', ['inspect', deployment, '--scope', team], {
      show: false,
      accept: [0, 1],
      env: linkedTo(team, frontend.project),
    });
    confirmed =
      inspected.status === 0 &&
      `${inspected.stdout}\n${inspected.stderr}`.split(/\s+/u).includes(origin);
  }
  if (!confirmed) {
    context.out(
      `Vercel did not list ${origin} for the new frontend deployment, so the control plane was ` +
        `not told to allow it. List ${origin} in allowedOrigins of the surface web/ calls, or ` +
        `set ${FRONTEND_ORIGIN_VARIABLE}=${origin} in ${controlPlane.project} and deploy again.\n`,
    );
    return;
  }
  // No Root Directory: `configurePart` has already set it for the control plane.
  const part: Part = {
    label: controlPlane.label,
    project: controlPlane.project,
    settingsFile: controlPlane.settingsFile,
    upload: controlPlane.upload,
    variables: [[FRONTEND_ORIGIN_VARIABLE, origin]],
  };
  await configurePart(context, part, team, await inspectPart(context, part, team));
}

/** Stages the part and runs `vercel deploy --prod` on it; the staged copy is always removed. */
async function deployPart(
  context: DeployContext,
  part: Part,
  source: string,
  team: string,
): Promise<ToolResult> {
  // One archive of a pruned copy, not a request per file of the checkout: a free team is
  // refused after 5000 files.
  const staged =
    'directory' in part.upload
      ? await stageDirectory(part.upload.directory)
      : await stagePlatform(source, part.upload.platformPackage);
  try {
    if (part.functionEntry === true && 'platformPackage' in part.upload) {
      await writeFunctionEntry(staged, part.upload.platformPackage);
    }
    // `--cwd`, not a positional path: the CLI warns "Did you mean to deploy the subdirectory
    // deploy?" when it runs in the project, which has a `deploy/` folder.
    return await runStep(
      context,
      'vercel',
      [
        'deploy',
        '--cwd',
        staged,
        '--archive=tgz',
        '--prod',
        '--yes',
        '--scope',
        team,
        '--local-config',
        path.resolve(context.directory, part.settingsFile),
      ],
      { show: true, env: linkedTo(team, part.project) },
    );
  } finally {
    await removeStaged(staged);
  }
}

/**
 * BH061-027: a plan without the token or team id reads nothing from Vercel, so it lists what an
 * apply sets on projects that do not exist yet instead of refusing.
 */
function planOffline(
  context: DeployContext,
  target: VercelTarget,
  dotEnv: Readonly<Record<string, string>>,
  unset: readonly string[],
): DeployOutcome {
  const { parts } = partsOf(context, target, `<${VERCEL_TEAM_ID_VARIABLE}>`, dotEnv);
  context.out(
    `${unset.join(' and ')} ${unset.length === 1 ? 'is' : 'are'} not set, so this plan reads ` +
      'nothing from Vercel: it lists what an apply sets on projects that do not exist yet.\n' +
      parts
        .map(
          (part) =>
            `Vercel project ${part.project} (${part.label}): ${String(part.variables.length)} ` +
            `${ENVIRONMENT} variable(s): ${part.variables.map(([name]) => name).join(', ')}.\n`,
        )
        .join('') +
      rootDirectoryNote(parts),
  );
  return { changes: true, applied: false };
}

/** `aw deploy` runs in a state directory named after the environment, so it names the project. */
function namedTarget(context: DeployContext, selected: VercelTarget): VercelTarget {
  const named = context.env[PROJECT_NAME_VARIABLE]?.trim() ?? '';
  return named === '' ? selected : { ...selected, projectName: composeProjectName(named) };
}

export async function deployWithVercel(
  context: DeployContext,
  selected: VercelTarget,
  dotEnv: Readonly<Record<string, string>>,
  apply: boolean,
): Promise<DeployOutcome> {
  const target = namedTarget(context, selected);
  const unset = [VERCEL_TOKEN_VARIABLE, VERCEL_TEAM_ID_VARIABLE].filter(
    (name) => (context.env[name]?.trim() ?? '') === '',
  );
  if (!apply && unset.length > 0) return planOffline(context, target, dotEnv, unset);
  requiredEnvironment(context.env, VERCEL_TOKEN_VARIABLE, 'the Vercel token');
  const team = requiredEnvironment(context.env, VERCEL_TEAM_ID_VARIABLE, 'the Vercel team id');

  // Everything an apply needs is refused by name before the first tool runs, so a missing value
  // never leaves a half-configured project behind.
  const source = apply
    ? path.resolve(
        context.directory,
        requiredEnvironment(context.env, VERCEL_SOURCE_VARIABLE, 'the platform checkout to deploy'),
      )
    : null;
  if (
    source !== null &&
    statSync(path.join(source, 'apps', 'web'), { throwIfNoEntry: false })?.isDirectory() !== true
  ) {
    throw new Error(
      `${VERCEL_SOURCE_VARIABLE} is ${source}, which has no apps/web directory: point it at a ` +
        'platform checkout. Nothing was run.',
    );
  }
  if (source !== null) assertOneRelease(source, dotEnv);
  const migration: Record<string, string> = {};
  for (const name of MIGRATION_VARIABLES) {
    const value = dotEnv[name]?.trim() ?? '';
    if (value !== '') migration[name] = value;
  }
  const webImage = dotEnv[ENV_IMAGE_KEYS.web]?.trim() ?? '';
  if (apply) {
    assertE2bTemplatePinned(dotEnv);
    assertVercelSandboxImagePinned(dotEnv, target.projectName);
    for (const [name, value] of [
      [ENV_IMAGE_KEYS.web, webImage],
      ['DATABASE_URL', migration['DATABASE_URL'] ?? ''],
      ['BOOTSTRAP_ADMIN', migration['BOOTSTRAP_ADMIN'] ?? ''],
    ] as const) {
      if (value === '') {
        throw new Error(
          `${name} is empty in .env: the migration step needs it` +
            (name === 'DATABASE_URL'
              ? ' (a Neon integration sets DATABASE_URL on Vercel, not in this file)'
              : '') +
            '. Set it and run again. Nothing was run.',
        );
      }
    }
    assertObjectStorageConfigured(dotEnv);
  }

  const { parts, addresses } = partsOf(context, target, team, dotEnv);
  await assertPartsStageable(source, parts);
  const states: PartState[] = [];
  for (const part of parts) states.push(await inspectPart(context, part, team));
  context.out(rootDirectoryNote(parts));
  context.out(
    `The control plane reaches the gateway at ${addresses.get('MODEL_GATEWAY_URL') ?? ''} and ` +
      `the runner manager at ${addresses.get('RUNNER_MANAGER_URL') ?? ''} (set MODEL_GATEWAY_URL ` +
      'or RUNNER_MANAGER_URL in .env for a custom domain). Applying also runs the database ' +
      'migrations once, then `vercel deploy --prod` for each project: every apply creates a ' +
      `deployment of each.${frontendNote(parts)}\n`,
  );

  if (!apply || source === null) return { changes: true, applied: false };

  for (const [index, part] of parts.entries()) {
    await configurePart(context, part, team, states[index] ?? { exists: true, missing: [] });
  }
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
  // The gateway and the manager are up before the control plane that calls them, and the frontend
  // before it too: its origin is written to the control plane before that is deployed.
  const controlPlane = parts.find((candidate) => candidate.label === 'control plane');
  for (const label of ['gateway', 'manager', 'frontend', 'control plane'] as const) {
    const part = parts.find((candidate) => candidate.label === label);
    if (part === undefined) continue;
    const deployed = await deployPart(context, part, source, team);
    if (label === 'frontend' && controlPlane !== undefined) {
      await allowFrontendOrigin(context, part, controlPlane, team, deployed);
    }
  }
  return { changes: true, applied: true };
}
