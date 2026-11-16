import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fixture, PASSWORD, PROJECT, REGISTRY, WEB_URL } from './gcp-fixtures.test-support.ts';
import { REQUIRED_GCP_APIS } from './gcp-preflight.js';
import type { ToolInvocation, ToolResult, ToolRunner } from './runner.js';
export interface World {
  bucket: boolean;
  stack: boolean;
  planExit: number;
  applyFails: string | null;
  /** What `terraform show -json` prints instead of the default plan. */
  planJson?: string;
  /** Whether the last `terraform plan -detailed-exitcode` the stub answered was empty. */
  lastPlanEmpty?: boolean;
  /** The project number the existing state bucket reports as its owner. */
  bucketOwner?: string;
  readonly images: Set<string>;
  /** Whether the sign-in client secret exists in Secret Manager; a targeted plan creates it. */
  secretExists?: boolean;
  /** Whether the sign-in client secret has an enabled version. */
  secretVersion?: boolean;
  secretFingerprint?: string;
  /** What `terraform output -json app_urls` prints; the output is absent when unset. */
  appsOutput?: string;
  /** What `terraform output -raw load_balancer_ip` prints; the output is absent when unset. */
  loadBalancerIp?: string;
  /** Whether the state holds the Cloud SQL instance; its targeted apply or the full apply adds it. */
  database?: boolean;
  /** The targets of the last `terraform plan`, which the next `terraform apply` applies. */
  lastPlanTargets?: readonly string[];
  /** Held until it resolves: the apply of the Cloud SQL targeted plan. */
  databaseApplyGate?: Promise<void>;
  /** What the Cloud SQL targeted apply prints on stderr when it fails. */
  databaseApplyFails?: string;
  /** What every image copy prints on stderr when it fails. */
  copyFails?: string;
}

export const DATABASE_TARGET = '-target=google_sql_database_instance.main';

export const ok = (stdout = ''): ToolResult => ({ status: 0, stdout, stderr: '' });
const GREEN: Readonly<Record<string, ToolResult>> = {
  'gcloud --version': ok('Google Cloud SDK 500.0.0'),
  'gcloud auth application-default print-access-token': ok('ya29.token'),
  'gcloud auth print-access-token': ok('ya29.token'),
  [`gcloud projects describe ${PROJECT} --format=value(projectNumber)`]: ok('123456789\n'),
  [`gcloud billing projects describe ${PROJECT} --format=value(billingEnabled)`]: ok('True\n'),
  [`gcloud services list --enabled --project ${PROJECT} --format=value(config.name)`]: ok(
    REQUIRED_GCP_APIS.join('\n'),
  ),
  'terraform version -json': ok(JSON.stringify({ terraform_version: '1.9.8' })),
  'terraform version': ok('Terraform v1.9.8'),
  'docker buildx version': ok('github.com/docker/buildx v0.17.0'),
};

/** The command line without Terraform's `-chdir=` prefix. */
export function commandLine({ tool, args }: ToolInvocation): string {
  const rest = args[0]?.startsWith('-chdir=') ? args.slice(1) : args;
  return [tool, ...rest].join(' ');
}

const chdirOf = ({ args }: ToolInvocation) => (args[0] ?? '').replace('-chdir=', '');

interface StubInvocation {
  readonly world: World;
  readonly invocation: ToolInvocation;
  readonly line: string;
}

async function bucket({
  world,
  invocation,
  line,
}: StubInvocation): Promise<ToolResult | undefined> {
  if (line.startsWith('gcloud storage buckets describe')) {
    if (!world.bucket) {
      return {
        status: 1,
        stdout: '',
        stderr: 'ERROR: HTTPError 404: The specified bucket does not exist.',
      };
    }
    // As gcloud does: only --raw prints the API's projectNumber; the display omits it.
    if (!invocation.args.includes('--raw')) return ok(await fixture('bucket-describe.json'));
    const raw = await fixture('bucket-describe-raw.json');
    return ok(
      raw.replace(
        '"projectNumber": "123456789"',
        `"projectNumber": "${world.bucketOwner ?? '123456789'}"`,
      ),
    );
  }
  if (line.startsWith('gcloud storage buckets create')) {
    world.bucket = true;
    return ok();
  }
  return undefined;
}

function secret({ world, line }: StubInvocation): ToolResult | undefined {
  if (line.startsWith('gcloud secrets describe')) {
    return world.secretExists === true
      ? ok(`${world.secretFingerprint ?? ''}\n`)
      : { status: 1, stdout: '', stderr: 'NOT_FOUND' };
  }
  if (line.startsWith('gcloud secrets versions list')) {
    return ok(world.secretVersion === true ? 'projects/1/secrets/x/versions/1\n' : '');
  }
  if (line.startsWith('gcloud secrets update')) {
    world.secretFingerprint = line.slice(
      line.indexOf('aw-oidc-client=') + 'aw-oidc-client='.length,
    );
    return ok();
  }
  if (line.startsWith('gcloud secrets versions add')) {
    world.secretVersion = true;
    return ok();
  }
  return undefined;
}

function terraformOutput({ world, line }: StubInvocation): ToolResult | undefined {
  if (line === 'terraform output -raw image_registry') {
    return world.stack
      ? ok(`${REGISTRY}\n`)
      : { status: 1, stdout: '', stderr: 'Error: Output "image_registry" not found' };
  }
  if (line === 'terraform output -raw web_url') return ok(WEB_URL);
  if (line === 'terraform output -json app_urls') {
    return world.appsOutput === undefined
      ? { status: 1, stdout: '', stderr: 'Error: Output "apps" not found' }
      : ok(world.appsOutput);
  }
  if (line === 'terraform output -raw load_balancer_ip') {
    return world.loadBalancerIp === undefined
      ? { status: 1, stdout: '', stderr: 'Error: Output "load_balancer_ip" not found' }
      : ok(`${world.loadBalancerIp}\n`);
  }
  if (line === 'terraform output -raw bootstrap_admin_password') return ok(`${PASSWORD}\n`);
  return undefined;
}

function terraformState({ world, line }: StubInvocation): ToolResult | undefined {
  if (line.startsWith('terraform state list ')) {
    return { status: 1, stdout: '', stderr: 'Error: Unknown resource\n' };
  }
  if (line === 'terraform state list') {
    return ok(
      world.database === true
        ? 'google_artifact_registry_repository.images\ngoogle_sql_database_instance.main\n'
        : 'google_artifact_registry_repository.images\n',
    );
  }
  return undefined;
}

async function terraformPlan({
  world,
  invocation,
  line,
}: StubInvocation): Promise<ToolResult | undefined> {
  if (line.startsWith('terraform plan')) {
    world.lastPlanTargets = invocation.args.filter((argument) => argument.startsWith('-target='));
    const detailed = line.includes('-detailed-exitcode');
    world.lastPlanEmpty = detailed && world.planExit === 0;
    if (line.includes('-target=google_secret_manager_secret.oidc_client_secret[0]')) {
      world.secretExists = true;
    }
    return { status: detailed ? world.planExit : 0, stdout: 'Plan: 3 to add.\n', stderr: '' };
  }
  if (line.startsWith('terraform show -json')) {
    return ok(
      world.planJson ?? (await fixture(world.lastPlanEmpty ? 'plan-empty.json' : 'plan.json')),
    );
  }
  return undefined;
}

async function terraformApply({ world, line }: StubInvocation): Promise<ToolResult | undefined> {
  if (line.startsWith('terraform apply')) {
    const targets = world.lastPlanTargets ?? [];
    if (targets.includes(DATABASE_TARGET)) {
      await world.databaseApplyGate;
      if (world.databaseApplyFails !== undefined) {
        return { status: 1, stdout: '', stderr: world.databaseApplyFails };
      }
      world.database = true;
      return ok('Cloud SQL apply complete!\n');
    }
    if (world.applyFails !== null) {
      return { status: 1, stdout: '', stderr: world.applyFails };
    }
    world.stack = true;
    if (targets.length === 0) world.database = true;
    return ok('Apply complete!\n');
  }
  return undefined;
}

function image({ world, invocation, line }: StubInvocation): ToolResult | undefined {
  if (line.startsWith('docker buildx imagetools create')) {
    if (world.copyFails !== undefined) return { status: 1, stdout: '', stderr: world.copyFails };
    const [tagged = '', source = ''] = invocation.args.slice(4);
    world.images.add(
      `${tagged.slice(0, tagged.lastIndexOf(':'))}${source.slice(source.indexOf('@'))}`,
    );
    return ok();
  }
  if (line.startsWith('docker buildx imagetools inspect')) {
    const reference = invocation.args[3] ?? '';
    return world.images.has(reference)
      ? ok(JSON.stringify({ digest: reference.slice(reference.indexOf('@') + 1) }))
      : { status: 1, stdout: '', stderr: 'not found' };
  }
  return undefined;
}

async function terraformInit({
  invocation,
  line,
}: StubInvocation): Promise<ToolResult | undefined> {
  if (line.startsWith('terraform init')) {
    await mkdir(path.join(chdirOf(invocation), '.terraform'), { recursive: true });
    return ok();
  }
  return undefined;
}

export function stub(world: World) {
  const calls: ToolInvocation[] = [];
  const runner: ToolRunner = async (invocation) => {
    calls.push(invocation);
    const line = commandLine(invocation);
    const green = GREEN[line];
    if (green !== undefined) return green;
    if (line.includes('org-policies')) return ok('{}');
    for (const handle of [
      bucket,
      secret,
      terraformOutput,
      terraformState,
      terraformPlan,
      terraformApply,
      image,
      terraformInit,
    ]) {
      const result = await handle({ world, invocation, line });
      if (result !== undefined) return result;
    }
    if (line.startsWith('gcloud')) return ok();
    return { status: 1, stdout: '', stderr: `unexpected call: ${line}` };
  };
  return { runner, calls };
}

/** The mutating and ordering-relevant calls, named; probes are left out. */
function milestone(invocation: ToolInvocation): string | null {
  const line = commandLine(invocation);
  const table: readonly [string, string][] = [
    ['gcloud --version', 'preflight'],
    ['gcloud storage buckets create', 'bucket create'],
    ['gcloud storage buckets update', 'bucket versioning'],
    ['terraform init', 'init'],
    ['gcloud auth configure-docker', 'configure docker'],
    ['docker buildx imagetools create', 'image copy'],
    ['terraform output -raw web_url', 'outputs'],
  ];
  for (const [prefix, name] of table) if (line.startsWith(prefix)) return name;
  if (line.startsWith('terraform plan'))
    return line.includes('-target=') ? 'targeted plan' : 'plan';
  if (line.startsWith('terraform apply')) return 'apply';
  return null;
}

export function milestones(calls: readonly ToolInvocation[]): readonly string[] {
  const named = calls.flatMap((call) => {
    const name = milestone(call);
    return name === null ? [] : [name];
  });
  return named.filter((name, index) => name !== named[index - 1]);
}
