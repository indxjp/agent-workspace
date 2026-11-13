import type { ProductionGcp } from '@indx-workspace/contracts/project-file';
import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomically } from '../render/write-file.ts';
import { firstStderrLine } from './cloud-run-images.ts';
import { field } from './gcp-json-fields.ts';
import type { StateBucketOutcome } from './gcp-lifecycle.ts';
import { readIfPresent } from './gcp-terraform-files.ts';
import { createRedactor } from './redact.ts';
import { runStep, type DeployContext } from './steps.ts';

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
