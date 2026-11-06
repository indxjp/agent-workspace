/**
 * The lifecycle of `aw deploy production` for a project that sets `environments.production.gcp`
 * (BYOC GCP phase P1): the generated Terraform variables, the state bucket, the automatic
 * `terraform init`, the staged apply, the plan summary, the failure report and the destroy plan.
 *
 * Plain functions over the injected `DeployContext` and `ToolRunner`. `project.ts` dispatches to
 * them in order; none of them reads the project file or the state directory's `.env`. The Google
 * credentials are the Owner's Application Default Credentials: nothing here reads, writes or
 * prints one.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { VertexLocation } from '@indx-workspace/contracts/models';
import type { ProductionGcp } from '@indx-workspace/contracts/project-file';

import { writeFileAtomically } from '../render/write-file.ts';
import { firstStderrLine } from './cloud-run-images.ts';
import {
  renderPreflightReport,
  runGcpPreflight,
  type GcpPreflightReport,
} from './gcp-preflight.ts';
import { createRedactor } from './redact.ts';
import { runStep, type DeployContext } from './steps.ts';
import { withPlanFile } from './terraform.ts';

/** The command that repeats a deploy that stopped half way; every step is safe to repeat. */
export function deployRerunCommand(apply: boolean): string {
  return apply ? 'aw deploy production --yes' : 'aw deploy production';
}

/** The module's resources a first deploy applies before the images can be copied. */
const FOUNDATION_TARGETS = [
  'google_project_service.required',
  'google_artifact_registry_repository.images',
] as const;

/**
 * The Cloud SQL instance, which a first deploy creates while the images copy: it takes 15 to 18
 * minutes and needs none of them. Terraform adds what it depends on (the APIs, the network, the
 * Private Services Access range and connection).
 */
const DATABASE_TARGETS = ['google_sql_database_instance.main'] as const;

/** The sign-in client secret's Terraform address: created without a version, filled by the CLI. */
const OIDC_SECRET_TARGETS = ['google_secret_manager_secret.oidc_client_secret[0]'] as const;

/** The resource kinds whose deletion or replacement loses data. */
const PROTECTED_KINDS: ReadonlyMap<string, string> = new Map([
  ['google_sql_database_instance', 'Cloud SQL instance'],
  ['google_storage_bucket', 'storage bucket'],
]);

const IDLE_COST_LINES = {
  small:
    'Idle cost: small: Cloud SQL shared-core, one warm web instance and the gateway internal load balancer are the idle costs',
  standard:
    'Idle cost: standard: regional high-availability Cloud SQL (db-custom-2-7680), at least one warm instance of every service and the gateway internal load balancer are the idle costs',
} as const;

const LEGACY_VARIABLES_NOTICE =
  'Using project_id from terraform.tfvars or TF_VAR_project_id; set environments.production.gcp ' +
  'in agent-workspace.yaml to let aw deploy manage the project, region and state bucket.';

/** The `variable "name"` default of the module: the repository `image_registry` names. */
const FALLBACK_RESOURCE_NAME = 'agent-ws';

/** What `terraform init` is told; `.aw-backend.json` records it with the module's provider hash. */
export interface StateBackend {
  readonly bucket: string;
  readonly prefix: string;
}

export function stateBucketName(gcp: ProductionGcp): string {
  return `${gcp.project}-aw-tfstate`;
}

export function backendFor(gcp: ProductionGcp, projectName: string): StateBackend {
  return { bucket: stateBucketName(gcp), prefix: `agent-workspace/${projectName}/production` };
}

/** The module's own rule for its `name` variable (`variables.tf`). */
const MODULE_NAME = /^[a-z][a-z0-9-]{1,20}[a-z0-9]$/u;

/**
 * The module's `name` variable for a project: the name itself when it is at most 19 characters
 * (the module adds up to `-runner-mgr`, and Google caps a service account id at 30), else its
 * first 14 characters, `-` and 4 hex characters of the name's sha256 (19 in all), so two projects
 * in one Google Cloud project get distinct resources; `agent-ws-` and that hash when no such name
 * is valid. Written to `terraform.tfvars.json`, which wins over `TF_VAR_name` and a
 * hand-written `terraform.tfvars`.
 */
export function moduleResourceName(projectName: string): string {
  if (projectName.length <= 19 && MODULE_NAME.test(projectName)) return projectName;
  const hash = createHash('sha256').update(projectName).digest('hex').slice(0, 4);
  const prefix = projectName.slice(0, 14).replace(/-+$/u, '');
  const name = `${prefix}-${hash}`;
  return MODULE_NAME.test(name) ? name : `${FALLBACK_RESOURCE_NAME}-${hash}`;
}

/**
 * The module's `image_registry` output, `<region>-docker.pkg.dev/<project>/<repository>`, computed
 * before the repository exists. The repository is the module's `name` variable
 * ({@link moduleResourceName}). `gcp-lifecycle.test.ts` holds this formula equal to `outputs.tf`.
 */
export function expectedImageRegistry(gcp: ProductionGcp, name: string): string {
  return `${gcp.region}-docker.pkg.dev/${gcp.project}/${name}`;
}

function seconds(started: number): string {
  return `${String(Math.max(0, Math.round((Date.now() - started) / 1000)))} s`;
}

/** The first line of `stderr` that Terraform calls an error, else its first line with text. */
function actionableLine(stderr: string): string {
  const error = stderr
    .split('\n')
    .map((line) => line.replace(/^[\s╷│╵]+/u, '').trim())
    .find((line) => line.startsWith('Error'));
  return error ?? firstStderrLine(stderr);
}

interface StepReport {
  /** The command that repeats the step. */
  readonly rerun?: string;
  /** Quote the thrown error, not the first line the tools printed (warnings included). */
  readonly quoteError?: boolean;
  /** Masks the failure's quoted text; defaults to the redactor that knows no `.env` value. */
  readonly redact?: (text: string) => string;
  /** A sentence added to the failure when the tools' stderr says why it happened. */
  readonly advise?: (stderr: string) => string | undefined;
}

/**
 * Run one lifecycle step, printing its title and its elapsed time. A failure is reported as the
 * step, the first actionable error line of what the tools printed (redacted) and the command that
 * repeats the step; the tools' own output was already printed in full.
 */
export async function lifecycleStep<T>(
  context: DeployContext,
  title: string,
  run: (context: DeployContext) => Promise<T>,
  { rerun = deployRerunCommand(true), advise, quoteError = false, redact }: StepReport = {},
): Promise<T> {
  const started = Date.now();
  let stderr = '';
  context.out(`${title} ...\n`);
  try {
    const result = await run({
      ...context,
      err: (text) => {
        stderr += text;
        context.err(text);
      },
    });
    context.out(`${title}: done in ${seconds(started)}\n`);
    return result;
  } catch (error) {
    const detail =
      quoteError || stderr.trim() === ''
        ? error instanceof Error
          ? error.message
          : String(error)
        : actionableLine(stderr);
    const advice = advise?.(stderr);
    throw new Error(
      `${title} failed after ${seconds(started)}: ${(redact ?? createRedactor({}))(detail)}\n` +
        `${advice === undefined ? '' : `${advice}\n`}` +
        `Every step is safe to repeat. Run it again: ${rerun}`,
      { cause: error },
    );
  }
}

/**
 * Check the Google Cloud project before anything is created and print the report. With `only`, just
 * those checks decide (the destroy path needs the tools, the sign-in and the project, not billing).
 *
 * @throws {Error} when a check failed.
 */
export async function runPreflight(
  context: DeployContext,
  gcp: ProductionGcp,
  apply: boolean,
  {
    only,
    fetch,
    loadBalancerIp,
    resolveHost,
  }: {
    readonly only?: readonly string[];
    readonly fetch?: typeof globalThis.fetch;
    readonly loadBalancerIp?: () => Promise<string | null>;
    readonly resolveHost?: (hostname: string) => Promise<unknown>;
  } = {},
): Promise<void> {
  const full = await runGcpPreflight({
    context,
    project: gcp.project,
    region: gcp.region,
    apply,
    ...(gcp.modelLocation === undefined ? {} : { modelLocation: gcp.modelLocation }),
    ...(fetch === undefined ? {} : { fetch }),
    ...(gcp.domain === undefined ? {} : { domain: gcp.domain }),
    ...(gcp.iap === undefined ? {} : { iap: gcp.iap }),
    ...(gcp.alertsEmail === undefined ? {} : { alertsEmail: gcp.alertsEmail }),
    ...(loadBalancerIp === undefined ? {} : { loadBalancerIp }),
    ...(resolveHost === undefined ? {} : { resolveHost }),
  });
  const checks =
    only === undefined ? full.checks : full.checks.filter(({ id }) => only.includes(id));
  const report: GcpPreflightReport = {
    ...full,
    checks,
    passed: !checks.some(({ status }) => status === 'fail'),
  };
  context.out(renderPreflightReport(report));
  if (!report.passed) {
    throw new Error('The Google Cloud checks failed. Nothing was created.');
  }
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** The files Terraform loads on its own, besides `terraform.tfvars.json`, that can set a variable. */
async function tfvarsFiles(directory: string): Promise<readonly string[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  return names
    .filter((name) => name === 'terraform.tfvars' || name.endsWith('.auto.tfvars'))
    .sort();
}

/**
 * Refuse a `project_id` or `region` that `terraform.tfvars` or a `*.auto.tfvars` file in
 * `directory` (and, with `env`, `TF_VAR_project_id`) sets to something other than the `gcp` block
 * (and, with `name`, a `name` other than it; `terraform.tfvars.json` would override it),
 * naming both, rather than leave a file to override one silently.
 *
 * @throws {Error} when such a value differs from `gcp`.
 */
export async function assertNoConflictingVariables(
  directory: string,
  gcp: ProductionGcp,
  env: NodeJS.ProcessEnv = {},
  name?: string,
): Promise<void> {
  const settings = [
    { key: 'project_id', setting: 'environments.production.gcp.project', wanted: gcp.project },
    { key: 'region', setting: 'environments.production.gcp.region', wanted: gcp.region },
    ...(name === undefined ? [] : [{ key: 'name', setting: 'the project name', wanted: name }]),
  ];
  for (const { key, setting, wanted } of settings) {
    const sources: [string, string | undefined][] = [];
    for (const name of await tfvarsFiles(directory)) {
      const text = (await readIfPresent(path.join(directory, name))) ?? '';
      sources.push([name, new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'mu').exec(text)?.[1]]);
    }
    if (key !== 'region') sources.push([`TF_VAR_${key}`, env[`TF_VAR_${key}`] || undefined]);
    const conflict = sources.find(([, value]) => value !== undefined && value !== wanted);
    if (conflict?.[1] !== undefined) {
      throw new Error(
        `${setting} is "${wanted}" but the ${key} (${conflict[0]}) is "${conflict[1]}". ` +
          `Remove the ${key} there, or make them equal. ` +
          'Nothing was created.',
      );
    }
  }
}

/**
 * Write `terraform.tfvars.json` (`project_id`, `region`, `name`, `vertex_location`, plus each optional `gcp` key that is set: `domain`, `armor`, `iap`, `oidc_*`, `data_protection`, `size`, `alerts_email`) into the CLI-owned module directory, where
 * Terraform loads it without a flag. A hand-written `terraform.tfvars` or `TF_VAR_project_id` that
 * names another project is refused, naming both, rather than left to override one silently.
 *
 * @throws {Error} when the legacy project id or region differs from `gcp`.
 */
export async function writeProjectVariables(
  moduleDirectory: string,
  gcp: ProductionGcp,
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await assertNoConflictingVariables(moduleDirectory, gcp, env, name);
  await writeFileAtomically(
    path.join(moduleDirectory, 'terraform.tfvars.json'),
    `${JSON.stringify(
      {
        project_id: gcp.project,
        region: gcp.region,
        name,
        vertex_location: gcp.modelLocation ?? 'global',
        // Written only when set, so a stack deployed before these keys existed plans no change.
        ...(gcp.domain === undefined ? {} : { domain: gcp.domain }),
        ...(gcp.armor === undefined ? {} : { armor: gcp.armor }),
        ...(gcp.iap === undefined ? {} : { iap: gcp.iap }),
        ...(gcp.oidc === undefined
          ? {}
          : { oidc_issuer: gcp.oidc.issuer, oidc_client_id: gcp.oidc.clientId }),
        ...(gcp.dataProtection === undefined ? {} : { data_protection: gcp.dataProtection }),
        ...(gcp.size === undefined ? {} : { size: gcp.size }),
        ...(gcp.alertsEmail === undefined ? {} : { alerts_email: gcp.alertsEmail }),
      },
      null,
      2,
    )}\n`,
    null,
  );
}

/** The notice for a project that still sets its Google Cloud project by hand. */
export function legacyVariablesNotice(): string {
  return `${LEGACY_VARIABLES_NOTICE}\n`;
}

export type StateBucketOutcome = 'exists' | 'created' | 'missing';

const BUCKET_NOT_FOUND = /\b404\b|not found|does not exist/iu;

/**
 * The project number a `gcloud storage buckets describe --raw --format=json` names, else `null`.
 * Only `--raw` prints the Cloud Storage API's `projectNumber` (a decimal string); the default
 * display drops it, which once made the deploy refuse the bucket it had just created.
 */
function bucketProjectNumber(describeJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(describeJson);
  } catch {
    return null;
  }
  const number = field(parsed, 'projectNumber');
  return typeof number === 'string' || typeof number === 'number' ? String(number) : null;
}

/**
 * Bucket names are global and this one follows from the project id, so another account may have
 * created it first. Terraform state holds the Owner's passwords: it is written only to a bucket
 * that belongs to `gcp.project`.
 */
async function assertOwnBucket(
  context: DeployContext,
  gcp: ProductionGcp,
  bucket: string,
  describeJson: string,
): Promise<void> {
  const project = await runStep(
    context,
    'gcloud',
    ['projects', 'describe', gcp.project, '--format=value(projectNumber)'],
    { show: false },
  );
  const wanted = project.stdout.trim();
  const owner = bucketProjectNumber(describeJson);
  if (owner === null) {
    throw new Error(
      `Could not read which project owns the state bucket ${bucket}: gcloud printed no ` +
        'projectNumber. Nothing was created.',
    );
  }
  if (wanted === '' || owner !== wanted) {
    throw new Error(
      `The state bucket name ${bucket} is taken by another project. Nothing was created.`,
    );
  }
}

/**
 * The Terraform state bucket `<project>-aw-tfstate`: described, and with `apply` created if absent
 * (uniform bucket-level access, public access prevention, object versioning). Without `apply` an
 * absent bucket is reported as `missing` and nothing is created.
 */
export async function ensureStateBucket(
  context: DeployContext,
  gcp: ProductionGcp,
  apply: boolean,
): Promise<StateBucketOutcome> {
  const bucket = `gs://${stateBucketName(gcp)}`;
  const described = await runStep(
    context,
    'gcloud',
    ['storage', 'buckets', 'describe', bucket, '--raw', '--format=json'],
    { show: false, accept: [0, 1] },
  );
  if (described.status === 0) {
    await assertOwnBucket(context, gcp, bucket, described.stdout);
    return 'exists';
  }
  if (!BUCKET_NOT_FOUND.test(described.stderr)) {
    throw new Error(
      `Could not read the state bucket ${bucket}: ` +
        `${createRedactor({})(firstStderrLine(described.stderr))}. Nothing was created.`,
    );
  }
  if (!apply) return 'missing';
  await runStep(
    context,
    'gcloud',
    [
      'storage',
      'buckets',
      'create',
      bucket,
      '--project',
      gcp.project,
      '--location',
      gcp.region,
      '--uniform-bucket-level-access',
      '--public-access-prevention',
    ],
    { show: false },
  );
  await runStep(context, 'gcloud', ['storage', 'buckets', 'update', bucket, '--versioning'], {
    show: false,
  });
  return 'created';
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

/** The file beside the module that records which backend its `.terraform/` was initialised for. */
export function backendRecord(moduleDirectory: string): string {
  return path.join(moduleDirectory, '.aw-backend.json');
}

/** The hash of the shipped module's provider requirements and lock file, which a release may change. */
async function providerRequirements(moduleDirectory: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of ['versions.tf', '.terraform.lock.hcl']) {
    hash.update(`${file}\0${(await readIfPresent(path.join(moduleDirectory, file))) ?? ''}\0`);
  }
  return hash.digest('hex');
}

/**
 * Whether a local `terraform.tfstate` holds resources. `init -migrate-state` leaves the file behind
 * empty, so only a file with resources, or one that does not parse, counts as state.
 */
function holdsResources(text: string | null): boolean {
  if (text === null) return false;
  try {
    const resources: unknown = field(JSON.parse(text), 'resources');
    return !Array.isArray(resources) || resources.length > 0;
  } catch {
    return true;
  }
}

/**
 * A stack that was initialised in this directory before the gcp block (another backend, or local
 * state) keeps its state where it is; initialising the managed backend over it would create a
 * second stack beside the first. Refused with the command that moves the state.
 */
async function assertNoUnmanagedState(
  moduleDirectory: string,
  backend: StateBackend,
): Promise<void> {
  const initialised = await readIfPresent(
    path.join(moduleDirectory, '.terraform', 'terraform.tfstate'),
  );
  let configured: unknown;
  try {
    configured = initialised === null ? undefined : field(JSON.parse(initialised), 'backend');
  } catch {
    configured = undefined;
  }
  const config = field(configured, 'config');
  const managed =
    field(configured, 'type') === 'gcs' &&
    field(config, 'bucket') === backend.bucket &&
    field(config, 'prefix') === backend.prefix;
  const hasState = holdsResources(
    await readIfPresent(path.join(moduleDirectory, 'terraform.tfstate')),
  );
  if ((configured !== undefined && !managed) || hasState) {
    throw new Error(
      `${moduleDirectory} already holds a Terraform stack with its own state, and ` +
        `environments.production.gcp would start a second one beside it. Move the state first: ` +
        `terraform -chdir=${moduleDirectory} init -migrate-state ` +
        `-backend-config=bucket=${backend.bucket} -backend-config=prefix=${backend.prefix}, ` +
        'The module names its resources after the project, so a stack with another name is ' +
        'not adopted: leave it as it is. Nothing was applied.',
    );
  }
}

/**
 * `terraform init -reconfigure` against the state bucket when `.terraform/` is missing, was
 * initialised for another backend, or the shipped module's provider requirements or lock file
 * changed (no `-upgrade`: init installs exactly the shipped lock); otherwise nothing. Returns
 * whether init ran.
 *
 * @throws {Error} when the directory holds a stack whose state is not in the managed backend.
 */
export async function initialiseBackend(
  context: DeployContext,
  moduleDirectory: string,
  backend: StateBackend,
): Promise<boolean> {
  const providers = await providerRequirements(moduleDirectory);
  const wanted = JSON.stringify({ ...backend, providers });
  const recorded = await readIfPresent(backendRecord(moduleDirectory));
  if (recorded === null) await assertNoUnmanagedState(moduleDirectory, backend);
  const current =
    recorded !== null &&
    recorded.trim() === wanted &&
    (await isDirectory(path.join(moduleDirectory, '.terraform')));
  if (current) return false;
  await runStep(
    context,
    'terraform',
    [
      `-chdir=${moduleDirectory}`,
      'init',
      '-input=false',
      '-reconfigure',
      `-backend-config=bucket=${backend.bucket}`,
      `-backend-config=prefix=${backend.prefix}`,
    ],
    { show: true },
  );
  await mkdir(moduleDirectory, { recursive: true, mode: 0o700 });
  await writeFileAtomically(backendRecord(moduleDirectory), `${wanted}\n`, null);
  return true;
}

/** The Secret Manager id of the sign-in client secret: the module's `${name}-oidc-client-secret`. */
export function oidcClientSecretId(name: string): string {
  return `${name}-oidc-client-secret`;
}

export interface OidcSecretInput {
  readonly moduleDirectory: string;
  readonly variablesFile: string;
  readonly project: string;
  readonly secretId: string;
  /** The `gcp.oidc` the stored value must belong to: a new issuer or client id asks again. */
  readonly oidc: { readonly issuer: string; readonly clientId: string };
  readonly env: NodeJS.ProcessEnv;
  /** Asks without echo; given only when the terminal is interactive. */
  readonly readSecret?: (question: string) => Promise<string>;
}

const OIDC_CLIENT_ANNOTATION = 'aw-oidc-client';

/** A label-safe digest of the issuer and client id a stored secret belongs to (not secret). */
function oidcClientFingerprint({ issuer, clientId }: OidcSecretInput['oidc']): string {
  return createHash('sha256').update(`${issuer}\n${clientId}`).digest('hex').slice(0, 32);
}

/**
 * Make sure the sign-in client secret has an enabled version in Secret Manager for the current
 * `gcp.oidc` issuer and client id: create the secret through a targeted apply when it is missing,
 * and add a version only when none is enabled or the stored one was entered for another issuer or
 * client (recorded as an annotation on the secret), so an unchanged re-run asks for nothing. The
 * value comes from `readSecret` (interactive), else `AW_OIDC_CLIENT_SECRET`, and reaches `gcloud` on stdin only. Returns the value it stored, for
 * the redactor, or `null` when a version was already there.
 *
 * @throws {Error} when a version is needed and neither source has the value.
 */
export async function storeOidcClientSecret(
  context: DeployContext,
  { moduleDirectory, variablesFile, project, secretId, oidc, env, readSecret }: OidcSecretInput,
): Promise<string | null> {
  const fingerprint = oidcClientFingerprint(oidc);
  const described = await runStep(
    context,
    'gcloud',
    [
      'secrets',
      'describe',
      secretId,
      '--project',
      project,
      `--format=value(annotations.${OIDC_CLIENT_ANNOTATION})`,
    ],
    { show: false, accept: [0, 1] },
  );
  if (described.status !== 0) {
    await applyFoundation(context, moduleDirectory, variablesFile, OIDC_SECRET_TARGETS);
  }
  const versions = await runStep(
    context,
    'gcloud',
    [
      'secrets',
      'versions',
      'list',
      secretId,
      '--project',
      project,
      '--filter=state:enabled',
      '--limit=1',
      '--format=value(name)',
    ],
    { show: false },
  );
  if (versions.stdout.trim() !== '' && described.stdout.trim() === fingerprint) {
    return null;
  }
  const question = 'Sign-in client secret from your identity provider (input is hidden)';
  const fromEnv = env['AW_OIDC_CLIENT_SECRET'];
  const value = (readSecret === undefined ? (fromEnv ?? '') : await readSecret(question)).trim();
  if (value === '') {
    throw new Error(
      'The sign-in client secret is needed once for this issuer and client id and is not stored ' +
        'yet. Run aw deploy production ' +
        '--yes in a terminal to be asked for it, or set AW_OIDC_CLIENT_SECRET to the secret and run ' +
        'it again. Nothing was applied.',
    );
  }
  await runStep(
    context,
    'gcloud',
    ['secrets', 'versions', 'add', secretId, '--project', project, '--data-file=-'],
    { show: false, input: value },
  );
  await runStep(
    context,
    'gcloud',
    [
      'secrets',
      'update',
      secretId,
      '--project',
      project,
      `--update-annotations=${OIDC_CLIENT_ANNOTATION}=${fingerprint}`,
    ],
    { show: false },
  );
  return value;
}

/**
 * The first stage of a first deploy: enable the APIs and create the image repository, from a plan
 * file with the rendered variables. This stage is applied without a preview of its own (a departure
 * from ADR-0094): the full plan that follows shows everything it created.
 */
export async function applyFoundation(
  context: DeployContext,
  moduleDirectory: string,
  variablesFile: string,
  targets: readonly string[] = FOUNDATION_TARGETS,
): Promise<void> {
  const chdir = `-chdir=${moduleDirectory}`;
  await withPlanFile(async (planFile) => {
    await runStep(
      context,
      'terraform',
      [
        chdir,
        'plan',
        '-input=false',
        `-var-file=${variablesFile}`,
        ...targets.map((target) => `-target=${target}`),
        `-out=${planFile}`,
      ],
      { show: false },
    );
    await runStep(context, 'terraform', [chdir, 'apply', '-input=false', planFile], {
      show: true,
    });
  });
}

/**
 * Whether the Terraform state already holds the Cloud SQL instance. The whole state is listed:
 * `terraform state list <address>` exits 1 ("Unknown resource") when the address is not in it.
 */
export async function holdsDatabase(
  context: DeployContext,
  moduleDirectory: string,
): Promise<boolean> {
  const listed = await runStep(
    context,
    'terraform',
    [`-chdir=${moduleDirectory}`, 'state', 'list'],
    {
      show: false,
    },
  );
  return listed.stdout.split('\n').some((line) => line.trim() === DATABASE_TARGETS[0]);
}

/** Create the Cloud SQL instance and what it depends on, as {@link applyFoundation} does. */
export function applyDatabase(
  context: DeployContext,
  moduleDirectory: string,
  variablesFile: string,
): Promise<void> {
  return applyFoundation(context, moduleDirectory, variablesFile, DATABASE_TARGETS);
}

/** A step's failure without the copy's "Nothing was applied.", which the targeted apply voids. */
function withoutNothingApplied(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.replace(/\s*Nothing was applied\.$/gmu, '');
}

/**
 * The slow part of a first deploy, overlapped: `copy` runs while `createDatabase` applies the
 * Cloud SQL instance, and both have settled before this returns, so the full apply starts only
 * after both. The copy prints one line per image and Terraform's output is printed when its command
 * ends, so neither block is interleaved. A failure of either is reported with the other's outcome:
 * the targeted apply may have created resources, so "Nothing was applied." no longer holds.
 *
 * @throws {Error} naming each failed step and what was left applied.
 */
export async function copyWhileCreatingDatabase<T>(
  copy: () => Promise<T>,
  createDatabase: () => Promise<void>,
): Promise<T> {
  const [database, copied] = await Promise.allSettled([createDatabase(), copy()]);
  if (database.status === 'fulfilled' && copied.status === 'fulfilled') return copied.value;
  const rest = 'The rest of the stack was not applied.';
  const databaseReason: unknown = database.status === 'rejected' ? database.reason : undefined;
  const copyReason: unknown = copied.status === 'rejected' ? copied.reason : undefined;
  if (copied.status === 'fulfilled') {
    throw new Error(
      `${withoutNothingApplied(databaseReason)}\nThe release images were copied. ${rest}`,
      { cause: databaseReason },
    );
  }
  if (database.status === 'fulfilled') {
    throw new Error(
      `${withoutNothingApplied(copyReason)}\n` +
        `Cloud SQL and its private network were created while the images copied. ${rest}`,
      { cause: copyReason },
    );
  }
  throw new AggregateError(
    [databaseReason, copyReason],
    `${withoutNothingApplied(databaseReason)}\n${withoutNothingApplied(copyReason)}\n` +
      `The Cloud SQL apply may have created part of its network. ${rest}`,
  );
}

type Json = Readonly<Record<string, unknown>>;

function field(value: unknown, key: string): unknown {
  return isJson(value) ? value[key] : undefined;
}

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type PlanAction = 'create' | 'update' | 'delete' | 'replace';
const PLAN_ACTIONS: readonly PlanAction[] = ['create', 'update', 'delete', 'replace'];

/** `change.actions` as one of the four the summary counts; `null` for no-op, read and the unknown. */
function planAction(actions: unknown): PlanAction | null {
  if (!Array.isArray(actions)) return null;
  const joined = actions.join(',');
  if (joined === 'create' || joined === 'update' || joined === 'delete') return joined;
  return joined === 'delete,create' || joined === 'create,delete' ? 'replace' : null;
}

interface PlanChange {
  readonly address: string;
  readonly kind: string;
  readonly action: PlanAction;
}

/** The plan's `size` variable (`variables.size.value`); `small`, the module's default, when absent. */
function planSize(planJson: string): keyof typeof IDLE_COST_LINES {
  const plan: unknown = JSON.parse(planJson);
  const variables = isJson(plan) ? plan['variables'] : undefined;
  const size =
    isJson(variables) && isJson(variables['size']) ? variables['size']['value'] : undefined;
  return size === 'standard' ? 'standard' : 'small';
}

function planChanges(planJson: string): readonly PlanChange[] {
  let plan: unknown;
  try {
    plan = JSON.parse(planJson);
  } catch (error) {
    throw new Error('`terraform show -json` did not print a plan', { cause: error });
  }
  const changes = isJson(plan) ? plan['resource_changes'] : undefined;
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((entry: unknown): PlanChange[] => {
    if (!isJson(entry) || !isJson(entry['change'])) return [];
    const action = planAction(entry['change']['actions']);
    const { address, type } = entry;
    return action !== null && typeof address === 'string' && typeof type === 'string'
      ? [{ address, kind: type, action }]
      : [];
  });
}

/**
 * The plan in four lines a person can act on: counts by action, counts by resource kind, any
 * protected resource (Cloud SQL, a bucket) that would be deleted or replaced, and the idle cost
 * class. `planJson` is `terraform show -json <planfile>`; nothing in it is printed but addresses.
 */
export function summarisePlan(planJson: string): string {
  const changes = planChanges(planJson);
  const total = (action: PlanAction) => changes.filter((entry) => entry.action === action).length;
  const kinds = [...new Set(changes.map(({ kind }) => kind))].sort();
  const lines = [
    'Plan summary',
    `  ${PLAN_ACTIONS.map((action) => `${String(total(action))} to ${action}`).join(', ')}`,
    '  By resource kind:',
    ...(kinds.length === 0 ? ['    nothing'] : []),
    ...kinds.map((kind) => {
      const counts = PLAN_ACTIONS.flatMap((action) => {
        const count = changes.filter(
          (entry) => entry.kind === kind && entry.action === action,
        ).length;
        return count === 0 ? [] : [`${String(count)} ${action}`];
      });
      return `    ${kind}: ${counts.join(', ')}`;
    }),
  ];
  const lost = changes.filter(
    ({ kind, action }) =>
      PROTECTED_KINDS.has(kind) && (action === 'delete' || action === 'replace'),
  );
  lines.push(
    ...(lost.length === 0
      ? ['  Protected resources: none would be deleted or replaced']
      : lost.map(
          ({ address, kind, action }) =>
            `  PROTECTED: ${address} (${PROTECTED_KINDS.get(kind) ?? kind}) would be ${action === 'replace' ? 'replaced' : 'deleted'}; its data is lost`,
        )),
    `  ${IDLE_COST_LINES[planSize(planJson)]}`,
  );
  return `${lines.join('\n')}\n`;
}

/** Whether the plan creates the web service, so a first deploy that must seed a model connection. */
export function planCreatesWeb(planJson: string): boolean {
  return planChanges(planJson).some(
    ({ address, kind, action }) =>
      kind === 'google_cloud_run_v2_service' &&
      address === 'google_cloud_run_v2_service.web' &&
      action === 'create',
  );
}

/** Print {@link summarisePlan} of the plan file at `planFile`, and return the plan's JSON. */
export async function showPlanSummary(
  context: DeployContext,
  moduleDirectory: string,
  planFile: string,
): Promise<string> {
  const shown = await runStep(
    context,
    'terraform',
    [`-chdir=${moduleDirectory}`, 'show', '-json', planFile],
    { show: false },
  );
  context.out(summarisePlan(shown.stdout));
  return shown.stdout;
}

const SEED_AGENT_NAME = 'Assistant';
const SEED_AGENT_INSTRUCTIONS = 'You are a helpful assistant.';

/** What the seeding waits for a new revision to warm up: 24 tries, 5 s apart (about 2 minutes). */
const SEED_ATTEMPTS = 24;
const SEED_INTERVAL_MS = 5000;

/**
 * Web's setup code for the runner manager's Cloud Run front end refusing web with an HTML 403
 * (`apps/web/server/setup/failure.ts`): web's `roles/run.invoker` grant, applied moments ago, has
 * not propagated yet. Setup writes nothing before its runtime test, so it is retried, with a
 * doubling delay, for at most `FORBIDDEN_WAIT_MS`; no other refusal is.
 */
const RUNTIME_MANAGER_FORBIDDEN = 'runtime_manager_forbidden';
const FORBIDDEN_WAIT_MS = 180_000;
const FORBIDDEN_FIRST_DELAY_MS = 5000;
const FORBIDDEN_MAX_DELAY_MS = 30_000;

/** The next wait for a propagating grant (5 s doubling to 30 s), or `null` once `FORBIDDEN_WAIT_MS` is spent. */
function grantPropagationDelays(): () => number | null {
  let waitedMs = 0;
  let nextMs = FORBIDDEN_FIRST_DELAY_MS;
  return () => {
    const delayMs = Math.min(nextMs, FORBIDDEN_WAIT_MS - waitedMs);
    if (delayMs <= 0) return null;
    waitedMs += delayMs;
    nextMs = Math.min(nextMs * 2, FORBIDDEN_MAX_DELAY_MS);
    return delayMs;
  };
}

export interface VertexSeed {
  readonly webUrl: string;
  readonly adminEmail: string;
  readonly location: VertexLocation;
  /** Reads the Owner's password when the request is made; held in memory only. */
  readonly password: () => Promise<string>;
  readonly fetch?: typeof fetch;
  /** Waits between tries; the suite injects a stub. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** The error `code` a refusal names, else `null`: never the rest of the body. */
async function refusalCode(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => null);
  const code = field(field(body, 'error'), 'code');
  return typeof code === 'string' ? code : null;
}

/**
 * The first deploy's model: complete the web app's setup with Claude on this install's own Vertex
 * AI (`POST /api/setup`, the path the setup wizard takes), so the install needs no model key. It
 * waits for a new revision to answer (503 or no connection), and for about three minutes for web's
 * new invoker grant on the runner manager to take effect (`runtime_manager_forbidden`). Whatever
 * fails is printed as a warning with the next step; the deploy still succeeds.
 *
 * @returns whether the connection was made.
 */
export async function seedVertexConnection(
  context: DeployContext,
  seed: VertexSeed,
): Promise<boolean> {
  const next = `next: open ${seed.webUrl} and choose Claude on Google Cloud (Vertex AI) in setup`;
  const warn = (reason: string): false => {
    context.out(`warning: Claude on Vertex AI was not connected (${reason})\n${next}\n`);
    return false;
  };
  let password: string;
  try {
    password = await seed.password();
  } catch {
    return warn('the Owner password could not be read');
  }
  const request = {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: seed.webUrl },
    body: JSON.stringify({
      provider: 'vertex',
      providerApiKey: '',
      runtime: 'cloud-run-service',
      adminEmail: seed.adminEmail,
      adminPassword: password,
      agentName: SEED_AGENT_NAME,
      agentInstructions: SEED_AGENT_INSTRUCTIONS,
    }),
  };
  const wait = seed.sleep ?? pause;
  let reason: string;
  let notReadyAttempts = 0;
  const nextGrantDelay = grantPropagationDelays();
  let waitingForGrant = false;
  for (;;) {
    let forbidden = false;
    try {
      const response = await (seed.fetch ?? fetch)(`${seed.webUrl}/api/setup`, request);
      if (response.ok) {
        context.out(
          `model: Claude on Vertex AI (${seed.location}), using this install's Google Cloud identity\n`,
        );
        return true;
      }
      const code = await refusalCode(response);
      reason = `HTTP ${String(response.status)}${code === null ? '' : ` ${code}`}`;
      forbidden = code === RUNTIME_MANAGER_FORBIDDEN;
      if (!forbidden && response.status !== 503) return warn(reason);
    } catch {
      reason = 'no connection';
    }
    if (forbidden) {
      const delayMs = nextGrantDelay();
      if (delayMs === null) return warn(reason);
      if (!waitingForGrant) context.out('Waiting for the new permission to reach Cloud Run...\n');
      waitingForGrant = true;
      await wait(delayMs);
    } else {
      notReadyAttempts += 1;
      if (notReadyAttempts >= SEED_ATTEMPTS) return warn(reason);
      await wait(SEED_INTERVAL_MS);
    }
  }
}

/** `terraform output -raw <name>`, or `null` when the state has no such output yet. */
export async function readTerraformOutput(
  context: DeployContext,
  moduleDirectory: string,
  name: 'web_url' | 'image_registry' | 'load_balancer_ip',
): Promise<string | null> {
  const result = await runStep(
    context,
    'terraform',
    [`-chdir=${moduleDirectory}`, 'output', '-raw', name],
    { show: false, accept: [0, 1] },
  );
  const value = result.stdout.trim();
  return result.status === 0 && value !== '' ? value : null;
}

/**
 * The Owner's generated password, from the Terraform state. The one value printed by `aw deploy
 * production --show-owner-password`; no other path reads it.
 */
export async function readOwnerPassword(
  context: DeployContext,
  moduleDirectory: string,
): Promise<string> {
  const result = await runStep(
    context,
    'terraform',
    [`-chdir=${moduleDirectory}`, 'output', '-raw', 'bootstrap_admin_password'],
    { show: false, accept: [0, 1] },
  );
  const password = result.stdout.trim();
  if (result.status !== 0 || password === '') {
    throw new Error(
      'The Owner password is not in the Terraform state yet: run aw deploy production --yes first. ' +
        `Terraform said: ${createRedactor({})(firstStderrLine(result.stderr))}`,
    );
  }
  return password;
}

/**
 * The protected resources the plan deletes, as human labels: a Cloud SQL instance or a Cloud Run
 * service with `deletion_protection` on, and a bucket without `force_destroy`. Terraform refuses
 * only inside the delete call, after it has destroyed other resources, so this is read from the
 * plan before anything is applied. `planJson` is `terraform show -json <planfile>`.
 */
function protectedDeletions(planJson: string): readonly string[] {
  let plan: unknown;
  try {
    plan = JSON.parse(planJson);
  } catch {
    return [];
  }
  const changes = field(plan, 'resource_changes');
  if (!Array.isArray(changes)) return [];
  const labels: string[] = [];
  const entries: readonly unknown[] = changes;
  for (const entry of entries) {
    const change = field(entry, 'change');
    if (planAction(field(change, 'actions')) !== 'delete') continue;
    const before = field(change, 'before');
    const settings = field(before, 'settings');
    const type = field(entry, 'type');
    const protectedNow =
      type === 'google_sql_database_instance'
        ? field(before, 'deletion_protection') === true ||
          (Array.isArray(settings) && field(settings[0], 'deletion_protection_enabled') === true)
        : type === 'google_cloud_run_v2_service'
          ? field(before, 'deletion_protection') === true
          : type === 'google_storage_bucket' && field(before, 'force_destroy') === false;
    if (protectedNow) {
      const kind = PROTECTED_KINDS.get(String(type)) ?? 'Cloud Run service';
      labels.push(`${String(field(entry, 'address'))} (${kind})`);
    }
  }
  return labels;
}

const DATA_PROTECTION =
  /deletion_protection|deletion protection|prevent_destroy|cannot be destroyed/iu;

/** What to tell the Owner when Terraform refuses to delete protected data. */
const DATA_PROTECTION_ADVICE =
  'To delete this stack and its data, set environments.production.gcp.dataProtection: false in ' +
  'agent-workspace.yaml, run aw deploy production --yes, then run aw deploy destroy production again.';

/** What Terraform says when Google Cloud still holds the network after the services are gone. */
const NETWORK_IN_USE = /resourceInUseByAnotherResource|is already being used by/u;

const NETWORK_RELEASE_NOTICE =
  'Google Cloud releases the network 1–2 hours after its services are deleted; everything else ' +
  'is gone. Run aw deploy destroy production again after that.';

/** Google Cloud keeps what a destroy cannot delete, and the module names it after the project. */
const REDEPLOY_NOTICE =
  'Destroyed. This project name cannot be deployed again in this Google Cloud project right away: ' +
  'Google Cloud keeps the KMS key ring and reserves the Cloud SQL instance name for about a week. ' +
  'To deploy sooner, rename the project in agent-workspace.yaml.';

/**
 * Plan the destruction of the stack, print its summary, and apply it only when `confirm` returns
 * the Google Cloud project id typed by the Owner.
 *
 * @throws {Error} when the typed id differs (before anything is applied), or Terraform refuses.
 */
export async function destroyStack(
  context: DeployContext,
  moduleDirectory: string,
  variablesFile: string,
  project: string,
  confirm: (question: string) => Promise<string>,
): Promise<void> {
  const chdir = `-chdir=${moduleDirectory}`;
  const report: StepReport = {
    rerun: 'aw deploy destroy production',
    advise: (stderr) =>
      DATA_PROTECTION.test(stderr)
        ? `Data protection is on, so Terraform will not delete protected data. ${DATA_PROTECTION_ADVICE}`
        : NETWORK_IN_USE.test(stderr)
          ? NETWORK_RELEASE_NOTICE
          : undefined,
  };
  await withPlanFile(async (planFile) => {
    let planJson = '';
    await lifecycleStep(
      context,
      'Plan the destruction',
      async (stepContext) => {
        await runStep(
          stepContext,
          'terraform',
          [
            chdir,
            'plan',
            '-destroy',
            '-input=false',
            `-var-file=${variablesFile}`,
            `-out=${planFile}`,
          ],
          { show: false },
        );
        const shown = await runStep(stepContext, 'terraform', [chdir, 'show', '-json', planFile], {
          show: false,
        });
        planJson = shown.stdout;
        stepContext.out(summarisePlan(planJson));
      },
      report,
    );
    const protectedLabels = protectedDeletions(planJson);
    if (protectedLabels.length > 0) {
      throw new Error(
        `Data protection is on, so nothing was destroyed: ${protectedLabels.join(', ')}. ${DATA_PROTECTION_ADVICE}`,
      );
    }
    const typed = (await confirm('Type the Google Cloud project id to delete everything')).trim();
    if (typed !== project) {
      throw new Error(`"${typed}" is not the project id ${project}. Nothing was destroyed.`);
    }
    await lifecycleStep(
      context,
      'Destroy the stack',
      (stepContext) =>
        runStep(stepContext, 'terraform', [chdir, 'apply', '-input=false', planFile], {
          show: true,
        }),
      report,
    );
    context.out(`${REDEPLOY_NOTICE}\n`);
  });
}
