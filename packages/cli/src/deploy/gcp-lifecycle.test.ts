import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ProductionGcp, ProjectDocument } from '@indx-workspace/contracts/project-file';
import { parseProjectFile } from '@indx-workspace/sdk/project';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeploymentImages } from '../deployment.js';
import { cloudRunModuleDirectory, materializeCloudRunModule } from './cloud-run-module.js';
import { REQUIRED_GCP_APIS, REQUIRED_GCP_PERMISSIONS } from './gcp-preflight.js';
import {
  backendFor,
  deployRerunCommand,
  expectedImageRegistry,
  initialiseBackend,
  lifecycleStep,
  moduleResourceName,
  summarisePlan,
  type StateBackend,
} from './gcp-lifecycle.js';
import {
  deployProjectEnvironment,
  destroyProjectEnvironment,
  showOwnerPassword,
  type DeployProjectEnvironmentOptions,
} from './project.js';
import { createRedactor } from './redact.js';
import type { ToolInvocation, ToolResult, ToolRunner } from './runner.js';
import type { DeployContext } from './steps.js';

const PROJECT = 'acme-prod';
const REGION = 'asia-northeast1';
const REGISTRY = `${REGION}-docker.pkg.dev/${PROJECT}/acme-ai`;
const PASSWORD = 'S3cretPassw0rd-XYZ-0123456789';
const WEB_URL = 'https://aw-web-abc123-an.a.run.app';
const PROVIDERS_HASH: unknown = expect.stringMatching(/^[0-9a-f]{64}$/u);
const digest = (character: string) => `sha256:${character.repeat(64)}`;

const release: DeploymentImages = {
  web: `ghcr.io/indxjp/aw-web@${digest('1')}`,
  gateway: `ghcr.io/indxjp/aw-gateway@${digest('2')}`,
  runner: `ghcr.io/indxjp/aw-runner@${digest('3')}`,
  runtime: `ghcr.io/indxjp/aw-runtime@${digest('4')}`,
  postgres: `registry.example/postgres@${digest('5')}`,
  seaweedfs: `registry.example/seaweedfs@${digest('6')}`,
};

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/gcp-lifecycle/${name}`, import.meta.url), 'utf8');
}

async function gcpProject(
  name = 'acme-ai',
  extra: Partial<ProductionGcp> = {},
): Promise<ProjectDocument> {
  const read = parseProjectFile(
    await readFile(
      new URL('./fixtures/production-gcp-cloudrun.project.yaml', import.meta.url),
      'utf8',
    ),
  );
  if (read.lifted) throw new Error('not a v2 project file');
  const production = read.project.environments.production;
  if (production === undefined) throw new Error('no production environment');
  return {
    ...read.project,
    name,
    environments: {
      ...read.project.environments,
      production: { ...production, gcp: { project: PROJECT, region: REGION, ...extra } },
    },
  };
}

/** What the stubbed Google Cloud and Terraform have created so far. */
interface World {
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

const DATABASE_TARGET = '-target=google_sql_database_instance.main';

const ok = (stdout = ''): ToolResult => ({ status: 0, stdout, stderr: '' });
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
function commandLine({ tool, args }: ToolInvocation): string {
  const rest = args[0]?.startsWith('-chdir=') ? args.slice(1) : args;
  return [tool, ...rest].join(' ');
}

const chdirOf = ({ args }: ToolInvocation) => (args[0] ?? '').replace('-chdir=', '');

function stub(world: World) {
  const calls: ToolInvocation[] = [];
  const runner: ToolRunner = async (invocation) => {
    calls.push(invocation);
    const line = commandLine(invocation);
    const green = GREEN[line];
    if (green !== undefined) return green;
    if (line.includes('org-policies')) return ok('{}');
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
    if (line.startsWith('terraform init')) {
      await mkdir(path.join(chdirOf(invocation), '.terraform'), { recursive: true });
      return ok();
    }
    if (line === 'terraform output -raw image_registry') {
      return world.stack
        ? ok(`${REGISTRY}\n`)
        : { status: 1, stdout: '', stderr: 'Error: Output "image_registry" not found' };
    }
    if (line === 'terraform output -raw web_url') return ok(WEB_URL);
    if (line === 'terraform output -raw load_balancer_ip') {
      return world.loadBalancerIp === undefined
        ? { status: 1, stdout: '', stderr: 'Error: Output "load_balancer_ip" not found' }
        : ok(`${world.loadBalancerIp}\n`);
    }
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
    if (line === 'terraform output -raw bootstrap_admin_password') return ok(`${PASSWORD}\n`);
    // Like Terraform: an address that is not in the state fails ("Unknown resource").
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

function milestones(calls: readonly ToolInvocation[]): readonly string[] {
  const named = calls.flatMap((call) => {
    const name = milestone(call);
    return name === null ? [] : [name];
  });
  return named.filter((name, index) => name !== named[index - 1]);
}

const temporary: string[] = [];
let output = '';

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
  output = '';
});

async function home(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aw-gcp-lifecycle-'));
  temporary.push(directory);
  return directory;
}

const granted: typeof fetch = () =>
  Promise.resolve(Response.json({ permissions: REQUIRED_GCP_PERMISSIONS }));

function capture(): void {
  const write = (chunk: string | Uint8Array): boolean => {
    output += String(chunk);
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(write);
  vi.spyOn(process.stderr, 'write').mockImplementation(write);
}

async function scenario(
  overrides: Partial<DeployProjectEnvironmentOptions> = {},
  initial: Partial<World> = {},
) {
  capture();
  const world: World = {
    bucket: false,
    stack: false,
    planExit: 2,
    applyFails: null,
    images: new Set<string>(),
    ...initial,
  };
  const { runner, calls } = stub(world);
  const root = await home();
  const stateDirectory = path.join(root, 'deployments', 'acme-ai', 'production');
  const options: DeployProjectEnvironmentOptions = {
    project: await gcpProject(),
    environment: 'production',
    apply: true,
    stateDirectory,
    env: {},
    images: release,
    nodeVersion: '24.1.0',
    runner,
    fetch: granted,
    ...overrides,
  };
  return {
    world,
    calls,
    runner,
    options,
    stateDirectory,
    moduleDirectory: cloudRunModuleDirectory(stateDirectory),
    run: (extra: Partial<DeployProjectEnvironmentOptions> = {}) =>
      deployProjectEnvironment({ ...options, ...extra }),
  };
}

const variablesOf = async (stateDirectory: string): Promise<{ images: Record<string, string> }> =>
  JSON.parse(
    await readFile(
      path.join(stateDirectory, 'deploy', 'terraform', 'gcp-cloudrun.auto.tfvars.json'),
      'utf8',
    ),
  ) as { images: Record<string, string> };

describe('aw deploy production with environments.production.gcp (BYOC P1)', () => {
  it('goes from an empty state to a running stack in the documented order', async () => {
    const { run, calls, moduleDirectory, stateDirectory } = await scenario();

    const outcome = await run();

    expect(milestones(calls)).toEqual([
      'preflight',
      'bucket create',
      'bucket versioning',
      'init',
      'targeted plan',
      'apply',
      'configure docker',
      'image copy',
      'targeted plan',
      'apply',
      'plan',
      'apply',
      'outputs',
    ]);
    expect(outcome).toMatchObject({ changes: true, applied: true, created: true, moduleDirectory });
    expect(outcome.nextSteps).toEqual([
      `web: ${WEB_URL}`,
      'sign-in: Owner password (set gcp.oidc for single sign-on)',
      "model: Claude on Vertex AI (global), using this install's Google Cloud identity",
      'owner: owner@acme.example',
      'owner password: aw deploy production --show-owner-password',
    ]);
    const lines = calls.map(commandLine);
    expect(lines).toContain(
      `gcloud storage buckets create gs://${PROJECT}-aw-tfstate --project ${PROJECT} --location ${REGION} --uniform-bucket-level-access --public-access-prevention`,
    );
    expect(lines).toContain(
      `gcloud storage buckets update gs://${PROJECT}-aw-tfstate --versioning`,
    );
    expect(lines).toContain(`gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet`);
    const init = calls.find((call) => commandLine(call).startsWith('terraform init'));
    expect(init?.args).toEqual([
      `-chdir=${moduleDirectory}`,
      'init',
      '-input=false',
      '-reconfigure',
      `-backend-config=bucket=${PROJECT}-aw-tfstate`,
      '-backend-config=prefix=agent-workspace/acme-ai/production',
    ]);
    const targeted = calls.find((call) => commandLine(call).includes('-target='));
    expect(targeted?.args).toEqual(
      expect.arrayContaining([
        '-target=google_project_service.required',
        '-target=google_artifact_registry_repository.images',
        `-var-file=${path.join(stateDirectory, 'deploy', 'terraform', 'gcp-cloudrun.auto.tfvars.json')}`,
      ]),
    );
    expect(
      JSON.parse(await readFile(path.join(moduleDirectory, 'terraform.tfvars.json'), 'utf8')),
    ).toEqual({
      project_id: PROJECT,
      region: REGION,
      name: 'acme-ai',
      vertex_location: 'global',
    });
    const recorded: StateBackend = JSON.parse(
      await readFile(path.join(moduleDirectory, '.aw-backend.json'), 'utf8'),
    ) as StateBackend;
    expect(recorded).toEqual({
      bucket: `${PROJECT}-aw-tfstate`,
      prefix: 'agent-workspace/acme-ai/production',
      providers: PROVIDERS_HASH,
    });
    expect((await variablesOf(stateDirectory)).images['web']).toBe(
      `${REGISTRY}/web@${digest('1')}`,
    );
    expect(output).toMatch(/Terraform state bucket \.\.\.\n/u);
    expect(output).toMatch(/Initialise Terraform: done in \d+ s/u);
    expect(output).toContain('Plan summary');
    expect(output).toContain('Applied.');
  });

  it('re-runs an existing stack with no bucket create, no init and an empty plan', async () => {
    const { run, calls, world } = await scenario();
    await run();
    world.planExit = 0;
    const before = calls.length;

    const outcome = await run();

    const second = calls.slice(before);
    expect(milestones(second)).toEqual(['preflight', 'plan', 'outputs']);
    expect(outcome).toMatchObject({ changes: false, applied: false });
    expect(output).toContain('No changes: the deployment matches agent-workspace.yaml.');
    expect(outcome.nextSteps[0]).toBe(`web: ${WEB_URL}`);
  });

  it('runs init with -reconfigure again when the backend changes', async () => {
    const { run, calls, world, moduleDirectory } = await scenario();
    await run();
    world.planExit = 0;
    const before = calls.length;

    await run({ project: await gcpProject('other-ai') });

    const init = calls.slice(before).find((call) => commandLine(call).startsWith('terraform init'));
    expect(init?.args).toContain('-reconfigure');
    expect(init?.args).toContain('-backend-config=prefix=agent-workspace/other-ai/production');
    expect(
      JSON.parse(await readFile(path.join(moduleDirectory, '.aw-backend.json'), 'utf8')),
    ).toEqual({
      bucket: `${PROJECT}-aw-tfstate`,
      prefix: 'agent-workspace/other-ai/production',
      providers: PROVIDERS_HASH,
    });
  });

  it('plans an empty state with the destination references and creates nothing', async () => {
    const { run, calls, stateDirectory } = await scenario({ apply: false }, { bucket: true });

    const outcome = await run();

    expect(outcome).toMatchObject({ changes: true, applied: false });
    const lines = calls.map(commandLine);
    expect(lines.some((line) => line.startsWith('gcloud storage buckets create'))).toBe(false);
    expect(lines.some((line) => line.startsWith('terraform apply'))).toBe(false);
    expect(lines.some((line) => line.includes('imagetools create'))).toBe(false);
    expect(lines.some((line) => line.includes('-target='))).toBe(false);
    expect(milestones(calls)).toEqual(['preflight', 'init', 'plan']);
    expect(output).toContain(`Would copy ${release.web} to ${REGISTRY}/web@${digest('1')}`);
    expect(output).toContain('Plan summary');
    expect((await variablesOf(stateDirectory)).images).toEqual({
      web: `${REGISTRY}/web@${digest('1')}`,
      gateway: `${REGISTRY}/gateway@${digest('2')}`,
      runner: `${REGISTRY}/runner@${digest('3')}`,
      runtime: `${REGISTRY}/runtime@${digest('4')}`,
    });
  });

  it('copies the images on --yes after a plan that pinned destinations it never copied', async () => {
    const { run, calls } = await scenario({ apply: false }, { bucket: true });
    await run();
    expect(calls.map(commandLine).some((line) => line.includes('imagetools create'))).toBe(false);
    calls.length = 0;

    await run({ apply: true });

    expect(
      calls.map(commandLine).filter((line) => line.includes('imagetools create')),
    ).toHaveLength(4);
  });

  it('refuses a state bucket that belongs to another project', async () => {
    const { run, calls } = await scenario({}, { bucket: true, bucketOwner: '999' });

    await expect(run()).rejects.toThrow('is taken by another project. Nothing was created.');

    expect(milestones(calls)).toEqual(['preflight']);
  });

  it('applies a plan with changes when a wrapper exits 0 for Terraform exit status 2', async () => {
    // Live run 41861782201: setup-terraform's terraform_wrapper exits 0 for a plan with changes,
    // and the deploy printed "Plan: 59 to add" and then "No changes" without applying anything.
    const { run, calls } = await scenario(
      {},
      { planExit: 0, planJson: await fixture('plan.json') },
    );

    const outcome = await run();

    expect(outcome).toMatchObject({ changes: true, applied: true });
    expect(milestones(calls).slice(-3)).toEqual(['plan', 'apply', 'outputs']);
    expect(output).toContain('Applied.');
    expect(output).not.toContain('No changes');
    expect(outcome.nextSteps[0]).toBe(`web: ${WEB_URL}`);
  });

  it('reads the plan file of an exit-0 plan and reports no changes when it changes nothing', async () => {
    const { run, calls, world } = await scenario();
    await run();
    world.planExit = 0;
    const before = calls.length;

    const outcome = await run();

    expect(outcome).toMatchObject({ changes: false, applied: false });
    const second = calls.slice(before).map(commandLine);
    expect(second.filter((line) => line.startsWith('terraform show -json'))).toHaveLength(1);
    expect(second.some((line) => line.startsWith('terraform apply'))).toBe(false);
    expect(output).toContain('No changes: the deployment matches agent-workspace.yaml.');
  });

  it('accepts the state bucket it created itself on the next run', async () => {
    // Live run 41861782201: the display of `gcloud storage buckets describe` has no project
    // number, so the re-run and the destroy refused the bucket the first run had created.
    const { run, calls } = await scenario({}, { bucket: true });

    await expect(run()).resolves.toMatchObject({ applied: true });

    const describe = calls.find((call) =>
      commandLine(call).startsWith('gcloud storage buckets describe'),
    );
    expect(describe?.args).toEqual([
      'storage',
      'buckets',
      'describe',
      `gs://${PROJECT}-aw-tfstate`,
      '--raw',
      '--format=json',
    ]);
    expect(milestones(calls)).not.toContain('bucket create');
  });

  it('says the state bucket would be created, and creates nothing, without --yes', async () => {
    const { run, calls, stateDirectory } = await scenario({ apply: false });

    const outcome = await run();

    expect(outcome).toMatchObject({ changes: true, applied: false, created: false });
    expect(output).toContain(`gs://${PROJECT}-aw-tfstate does not exist yet`);
    expect(milestones(calls)).toEqual(['preflight']);
    await expect(access(stateDirectory)).rejects.toThrow();
  });

  it('refuses before anything is created when a preflight check fails', async () => {
    const { run, calls, stateDirectory } = await scenario({
      fetch: () => Promise.resolve(Response.json({ permissions: [] })),
    });

    await expect(run()).rejects.toThrow('Nothing was created.');

    expect(milestones(calls)).toEqual(['preflight']);
    await expect(access(stateDirectory)).rejects.toThrow();
  });

  it('reports the failed step, the first Terraform error and the re-run command', async () => {
    const { run } = await scenario(
      {},
      { applyFails: '╷\n│ Error: Error enabling service run.googleapis.com: 403\n│ \n╵\n' },
    );

    const failure = await run().then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(failure).toContain('Enable the APIs and create the image repository failed after');
    expect(failure).toContain('Error: Error enabling service run.googleapis.com: 403');
    expect(failure).toContain('Run it again: aw deploy production --yes');
  });

  describe('Cloud SQL while the images copy', () => {
    const isCopy = (call: ToolInvocation) =>
      commandLine(call).startsWith('docker buildx imagetools create');
    const isFullPlan = (call: ToolInvocation) =>
      commandLine(call).startsWith('terraform plan') && !commandLine(call).includes('-target=');
    const isDatabasePlan = (call: ToolInvocation) =>
      commandLine(call).startsWith('terraform plan') && call.args.includes(DATABASE_TARGET);

    /** A gate the test opens: `open` resolves `promise`. */
    function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
      let open = () => {};
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { promise, open };
    }

    function failureOf(run: () => Promise<unknown>): Promise<string> {
      return run().then(
        () => 'the deploy succeeded',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    }

    it('starts the Cloud SQL apply before the copies finish, and the full apply only after both', async () => {
      const database = gate();
      const copies = gate();
      const events: string[] = [];
      let copiesStarted = 0;
      let databaseApplying = false;
      const setup = await scenario({}, { databaseApplyGate: database.promise });
      const runner: ToolRunner = async (invocation) => {
        const line = commandLine(invocation);
        if (isCopy(invocation)) {
          copiesStarted += 1;
          await copies.promise;
          events.push('copy finished');
        }
        if (isFullPlan(invocation)) events.push('full plan');
        const databaseApply =
          line.startsWith('terraform apply') &&
          (setup.world.lastPlanTargets ?? []).includes(DATABASE_TARGET);
        if (databaseApply) databaseApplying = true;
        const result = await setup.runner(invocation);
        if (databaseApply) events.push('Cloud SQL applied');
        return result;
      };

      const run = setup.run({ runner });
      await vi.waitFor(() => {
        expect(copiesStarted).toBe(4);
        expect(databaseApplying).toBe(true);
      });
      expect(events).toEqual([]);

      copies.open();
      await vi.waitFor(() => expect(events).toHaveLength(4));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events).toEqual(['copy finished', 'copy finished', 'copy finished', 'copy finished']);

      database.open();
      const outcome = await run;

      expect(outcome).toMatchObject({ changes: true, applied: true });
      expect(events.slice(4)).toEqual(['Cloud SQL applied', 'full plan']);
      expect(output).toContain(
        'Create Cloud SQL and its private network while the images copy ...',
      );
      for (const name of ['web', 'gateway', 'runner', 'runtime']) {
        expect(output).toContain(`Copied ${name}.`);
      }
      expect(output).toContain('Cloud SQL apply complete!');
    });

    it('reports a failed copy with what the Cloud SQL apply created, and applies nothing else', async () => {
      const { run, calls, world } = await scenario({}, { copyFails: 'denied: permission\n' });

      const failure = await failureOf(run);

      expect(failure).toContain('Copy the release images failed after');
      expect(failure).toContain(
        'Cloud SQL and its private network were created while the images copied. ' +
          'The rest of the stack was not applied.',
      );
      expect(failure).not.toContain('Nothing was applied.');
      expect(world.database).toBe(true);
      expect(calls.some(isFullPlan)).toBe(false);
    });

    it('reports a failed Cloud SQL apply after the copies, and applies nothing else', async () => {
      const { run, calls } = await scenario(
        {},
        { databaseApplyFails: '╷\n│ Error: Error, failed to create instance acme-ai-pg: 409\n╵\n' },
      );

      const failure = await failureOf(run);

      expect(failure).toContain(
        'Create Cloud SQL and its private network while the images copy failed after',
      );
      expect(failure).toContain('Error: Error, failed to create instance acme-ai-pg: 409');
      expect(failure).toContain(
        'The release images were copied. The rest of the stack was not applied.',
      );
      expect(calls.filter(isCopy)).toHaveLength(4);
      expect(calls.some(isFullPlan)).toBe(false);
    });

    it('reports both failures when the copy and the Cloud SQL apply fail', async () => {
      const { run, calls } = await scenario(
        {},
        {
          copyFails: 'denied: permission\n',
          databaseApplyFails: 'Error: Error waiting for Create Service Networking Connection\n',
        },
      );

      const failure = await failureOf(run);

      expect(failure).toContain(
        'Create Cloud SQL and its private network while the images copy failed after',
      );
      expect(failure).toContain('Error waiting for Create Service Networking Connection');
      expect(failure).toContain('Copy the release images failed after');
      expect(failure).toContain(
        'The Cloud SQL apply may have created part of its network. ' +
          'The rest of the stack was not applied.',
      );
      expect(calls.some(isFullPlan)).toBe(false);
    });

    it('runs no Cloud SQL apply without --yes, nor once the instance is in the state', async () => {
      const { run, calls, world } = await scenario({ apply: false }, { bucket: true });
      await run();
      expect(calls.some((call) => commandLine(call).startsWith('terraform state list'))).toBe(
        false,
      );

      await run({ apply: true });
      expect(calls.filter(isDatabasePlan)).toHaveLength(1);
      expect(world.database).toBe(true);
      const before = calls.length;

      await run({ apply: true });

      const again = calls.slice(before);
      expect(again.map(commandLine)).toContain('terraform state list');
      expect(again.some(isDatabasePlan)).toBe(false);
      expect(again.some(isFullPlan)).toBe(true);
    });
  });

  describe('Claude on Vertex AI (D-3)', () => {
    const SETUP_URL = `${WEB_URL}/api/setup`;

    /** The plan fixture plus a web service the apply creates (or only updates). */
    async function planWith(action: 'create' | 'update' | null): Promise<string> {
      const parsed = JSON.parse(await fixture('plan.json')) as {
        resource_changes: Record<string, unknown>[];
      };
      const plan = {
        ...parsed,
        resource_changes: parsed.resource_changes.filter(
          (change) => change['address'] !== 'google_cloud_run_v2_service.web',
        ),
      };
      if (action !== null) {
        plan.resource_changes.push({
          address: 'google_cloud_run_v2_service.web',
          type: 'google_cloud_run_v2_service',
          name: 'web',
          change: { actions: [action], before: null, after: {} },
        });
      }
      return JSON.stringify(plan);
    }

    interface Setup {
      readonly url: string;
      readonly init: RequestInit | undefined;
    }

    /** A refusal that names its own code; a bare status answers `setup_unavailable`. */
    interface Refusal {
      readonly status: number;
      readonly code: string;
    }

    /** A fetch that answers setup with `answers` in turn (the last one repeats). */
    function fetchSetup(answers: readonly (number | Error | Refusal)[]) {
      const setups: Setup[] = [];
      const fetchStub: typeof fetch = (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.endsWith('/api/setup')) return granted(input, init);
        setups.push({ url, init });
        const answer = answers[Math.min(setups.length, answers.length) - 1] ?? 201;
        if (answer instanceof Error) return Promise.reject(answer);
        const { status, code } =
          typeof answer === 'number' ? { status: answer, code: 'setup_unavailable' } : answer;
        return Promise.resolve(
          status < 300
            ? Response.json({ agentId: 'a' }, { status })
            : Response.json({ error: { code, message: PASSWORD } }, { status }),
        );
      };
      return { fetchStub, setups };
    }

    const noWait = () => Promise.resolve();

    it('creates the web service, then connects Claude through POST /api/setup with the Owner password', async () => {
      const { fetchStub, setups } = fetchSetup([201]);
      const { run, calls } = await scenario(
        { fetch: fetchStub, sleep: noWait },
        { planJson: await planWith('create') },
      );

      const outcome = await run();

      expect(setups).toHaveLength(1);
      expect(setups[0]?.url).toBe(SETUP_URL);
      expect(setups[0]?.init?.method).toBe('POST');
      expect(setups[0]?.init?.headers).toEqual({
        'content-type': 'application/json',
        origin: WEB_URL,
      });
      expect(JSON.parse(String(setups[0]?.init?.body as string))).toEqual({
        provider: 'vertex',
        providerApiKey: '',
        runtime: 'cloud-run-service',
        adminEmail: 'owner@acme.example',
        adminPassword: PASSWORD,
        agentName: 'Assistant',
        agentInstructions: 'You are a helpful assistant.',
      });
      const lines = calls.map(commandLine);
      expect(lines.lastIndexOf('terraform output -raw web_url')).toBeLessThan(
        lines.indexOf('terraform output -raw bootstrap_admin_password'),
      );
      expect(output).toMatch(/Connect Claude on Vertex AI \.\.\.\n/u);
      expect(output).toContain(
        "model: Claude on Vertex AI (global), using this install's Google Cloud identity",
      );
      expect(outcome.nextSteps).toContain(
        "model: Claude on Vertex AI (global), using this install's Google Cloud identity",
      );
      expect(outcome.nextSteps).not.toContain(
        'model: connect one on the Models screen if you have not yet',
      );
      expect(output).not.toContain(PASSWORD);
    });

    it('names the project location in the summary', async () => {
      const { fetchStub } = fetchSetup([201]);
      const { run } = await scenario(
        {
          fetch: fetchStub,
          sleep: noWait,
          project: await gcpProject('acme-ai', { modelLocation: 'eu' }),
        },
        { planJson: await planWith('create') },
      );

      const outcome = await run();

      expect(outcome.nextSteps).toContain(
        "model: Claude on Vertex AI (eu), using this install's Google Cloud identity",
      );
    });

    it.each([
      ['an update of web', 'update'],
      ['no change to web', null],
    ] as const)('does not call setup after %s', async (_name, action) => {
      const { fetchStub, setups } = fetchSetup([201]);
      const { run, calls } = await scenario(
        { fetch: fetchStub, sleep: noWait },
        { planJson: await planWith(action) },
      );

      const outcome = await run();

      expect(setups).toHaveLength(0);
      expect(calls.map(commandLine)).not.toContain(
        'terraform output -raw bootstrap_admin_password',
      );
      expect(output).not.toContain('Connect Claude on Vertex AI');
      expect(outcome.nextSteps).toContain(
        'model: connect one on the Models screen if you have not yet',
      );
    });

    it('does not call setup when nothing was applied', async () => {
      const { fetchStub, setups } = fetchSetup([201]);
      const { run } = await scenario(
        { fetch: fetchStub, sleep: noWait, apply: false },
        { planJson: await planWith('create') },
      );

      await run();

      expect(setups).toHaveLength(0);
    });

    it('waits for the new revision on 503 and on a refused connection, then succeeds', async () => {
      const { fetchStub, setups } = fetchSetup([503, new TypeError('fetch failed'), 503, 201]);
      const sleep = vi.fn(noWait);
      const { run } = await scenario(
        { fetch: fetchStub, sleep },
        { planJson: await planWith('create') },
      );

      const outcome = await run();

      expect(setups).toHaveLength(4);
      expect(sleep).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledWith(5000);
      expect(outcome.nextSteps).toContain(
        "model: Claude on Vertex AI (global), using this install's Google Cloud identity",
      );
    });

    it('gives up after about two minutes of 503 with a visible warning, and the deploy succeeds', async () => {
      const { fetchStub, setups } = fetchSetup([503]);
      const sleep = vi.fn(noWait);
      const { run } = await scenario(
        { fetch: fetchStub, sleep },
        { planJson: await planWith('create') },
      );

      const outcome = await run();

      expect(setups).toHaveLength(24);
      expect(sleep.mock.calls.length * 5000).toBeLessThanOrEqual(120_000);
      expect(outcome).toMatchObject({ applied: true });
      expect(output).toContain(
        'warning: Claude on Vertex AI was not connected (HTTP 503 setup_unavailable)',
      );
      expect(output).toContain(
        `next: open ${WEB_URL} and choose Claude on Google Cloud (Vertex AI) in setup`,
      );
      expect(outcome.nextSteps).toContain(
        'model: connect one on the Models screen if you have not yet',
      );
    });

    it('does not retry a refusal, and prints the status and code, never the body', async () => {
      const { fetchStub, setups } = fetchSetup([409]);
      const { run } = await scenario(
        { fetch: fetchStub, sleep: noWait },
        { planJson: await planWith('create') },
      );

      const outcome = await run();

      expect(setups).toHaveLength(1);
      expect(output).toContain('(HTTP 409 setup_unavailable)');
      expect(output).not.toContain(PASSWORD);
      expect(outcome.nextSteps).toContain(
        'model: connect one on the Models screen if you have not yet',
      );
    });

    describe("web's new invoker grant on the runner manager", () => {
      const FORBIDDEN: Refusal = { status: 500, code: 'runtime_manager_forbidden' };
      const WAITING = 'Waiting for the new permission to reach Cloud Run...\n';

      it('retries a front-end 403 with a growing delay, says so once, and succeeds once setup passes', async () => {
        const { fetchStub, setups } = fetchSetup([FORBIDDEN, FORBIDDEN, 201]);
        const sleep = vi.fn<(milliseconds: number) => Promise<void>>(noWait);
        const { run } = await scenario(
          { fetch: fetchStub, sleep },
          { planJson: await planWith('create') },
        );

        const outcome = await run();

        expect(setups).toHaveLength(3);
        expect(sleep.mock.calls).toEqual([[5000], [10_000]]);
        expect(output.split(WAITING)).toHaveLength(2);
        expect(outcome.nextSteps).toContain(
          "model: Claude on Vertex AI (global), using this install's Google Cloud identity",
        );
      });

      it('gives up after three minutes of waiting with the same warning, and the deploy succeeds', async () => {
        const { fetchStub, setups } = fetchSetup([FORBIDDEN]);
        const sleep = vi.fn<(milliseconds: number) => Promise<void>>(noWait);
        const { run } = await scenario(
          { fetch: fetchStub, sleep },
          { planJson: await planWith('create') },
        );

        const outcome = await run();

        const waited = sleep.mock.calls.reduce((total, [ms]) => total + ms, 0);
        expect(waited).toBe(180_000);
        expect(sleep.mock.calls.every(([ms]) => ms <= 30_000)).toBe(true);
        expect(setups).toHaveLength(sleep.mock.calls.length + 1);
        expect(outcome).toMatchObject({ applied: true });
        expect(output).toContain(
          'warning: Claude on Vertex AI was not connected (HTTP 500 runtime_manager_forbidden)',
        );
        expect(output).not.toContain(PASSWORD);
      });

      it.each([
        ['setup_failed', { status: 500, code: 'setup_failed' }],
        ['a 403 with another code', { status: 403, code: 'forbidden' }],
      ] as const)('does not retry %s', async (_name, refusal) => {
        const { fetchStub, setups } = fetchSetup([refusal, 201]);
        const sleep = vi.fn<(milliseconds: number) => Promise<void>>(noWait);
        const { run } = await scenario(
          { fetch: fetchStub, sleep },
          { planJson: await planWith('create') },
        );

        await run();

        expect(setups).toHaveLength(1);
        expect(sleep).not.toHaveBeenCalled();
        expect(output).not.toContain(WAITING);
        expect(output).toContain(`(HTTP ${String(refusal.status)} ${refusal.code})`);
      });
    });

    it('masks the Owner password in anything the step prints', async () => {
      const { fetchStub } = fetchSetup([new Error(`connect failed for ${PASSWORD}`)]);
      const { run } = await scenario(
        { fetch: fetchStub, sleep: noWait },
        { planJson: await planWith('create') },
      );

      await run();

      expect(output).toContain('Claude on Vertex AI was not connected (no connection)');
      expect(output).not.toContain(PASSWORD);
    });
  });

  it('never prints the Owner password in its default output, and prints only it on request', async () => {
    const { run, options } = await scenario();

    const outcome = await run();

    expect(output).not.toContain(PASSWORD);
    expect(outcome.nextSteps.join('\n')).not.toContain(PASSWORD);
    output = '';
    const password = await showOwnerPassword(options);
    expect(password).toBe(PASSWORD);
    expect(output).toBe('');
  });

  describe('sign-in client secret (gcp.oidc)', () => {
    const SECRET = 'oidc-Client-S3cret-0123456789';
    const oidc = { issuer: 'https://accounts.example.com', clientId: 'client-1' };
    const withOidc = async (extra: Partial<ProductionGcp> = {}) => ({
      project: await gcpProject('acme-ai', { oidc, ...extra }),
    });
    const secretCalls = (calls: readonly ToolInvocation[]) =>
      calls.map(commandLine).filter((line) => line.startsWith('gcloud secrets'));

    it('asks once, creates the secret with a targeted apply and stores the value on stdin only', async () => {
      const { run, calls } = await scenario(await withOidc());
      const readSecret = vi.fn(() => Promise.resolve(SECRET));

      await run({ readSecret });

      expect(readSecret).toHaveBeenCalledTimes(1);
      const lines = calls.map(commandLine);
      const created = lines.findIndex((line) =>
        line.includes('-target=google_secret_manager_secret.oidc_client_secret[0]'),
      );
      const added = lines.findIndex((line) => line.startsWith('gcloud secrets versions add'));
      const copy = lines.findIndex((line) => line.startsWith('docker buildx imagetools create'));
      expect(created).toBeGreaterThan(-1);
      expect(added).toBeGreaterThan(created);
      expect(copy).toBeGreaterThan(added);
      expect(lines[added]).toBe(
        `gcloud secrets versions add acme-ai-oidc-client-secret --project ${PROJECT} --data-file=-`,
      );
      expect(calls[added]?.input).toBe(SECRET);
      expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(SECRET);
      expect(output).toContain('Store the sign-in client secret: done');
      expect(output).not.toContain(SECRET);
    });

    it('asks for nothing on a re-run that finds a version', async () => {
      const { run, calls, world } = await scenario(await withOidc());
      await run({ readSecret: () => Promise.resolve(SECRET) });
      world.planExit = 0;
      const before = calls.length;
      const readSecret = vi.fn(() => Promise.resolve(SECRET));

      await run({ readSecret });

      expect(readSecret).not.toHaveBeenCalled();
      expect(secretCalls(calls.slice(before)).some((line) => line.includes('versions add'))).toBe(
        false,
      );
      expect(calls.slice(before).some((call) => commandLine(call).includes('-target='))).toBe(
        false,
      );
    });

    it.each([
      ['client id', { issuer: oidc.issuer, clientId: 'client-2' }],
      ['issuer', { issuer: 'https://other.example.com', clientId: oidc.clientId }],
    ])('asks again when the %s changes while a version is stored', async (_label, changed) => {
      const first = await scenario(await withOidc());
      await first.run({ readSecret: () => Promise.resolve(SECRET) });
      const { run, calls } = await scenario(
        { project: await gcpProject('acme-ai', { oidc: changed }) },
        {
          secretExists: true,
          secretVersion: true,
          ...(first.world.secretFingerprint === undefined
            ? {}
            : { secretFingerprint: first.world.secretFingerprint }),
        },
      );
      const readSecret = vi.fn(() => Promise.resolve('new-S3cret-0123456789'));

      await run({ readSecret });

      expect(readSecret).toHaveBeenCalledTimes(1);
      const lines = calls.map(commandLine);
      expect(lines.some((line) => line.startsWith('gcloud secrets versions add'))).toBe(true);
      expect(lines.some((line) => line.startsWith('gcloud secrets update'))).toBe(true);
    });

    it('reads AW_OIDC_CLIENT_SECRET when the terminal is not interactive', async () => {
      const { run, calls } = await scenario({
        ...(await withOidc()),
        env: { AW_OIDC_CLIENT_SECRET: SECRET },
      });

      await run();

      const add = calls.find((call) => commandLine(call).startsWith('gcloud secrets versions add'));
      expect(add?.input).toBe(SECRET);
    });

    it('refuses, naming both ways, when there is no terminal and no environment value', async () => {
      const { run, calls } = await scenario(await withOidc());

      const failure = await run().then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

      expect(failure).toContain('Store the sign-in client secret failed');
      expect(failure).toContain('AW_OIDC_CLIENT_SECRET');
      expect(failure).toContain('in a terminal');
      expect(calls.map(commandLine).some((line) => line.includes('imagetools create'))).toBe(false);
    });

    it('only notes that the secret will be asked for without --yes', async () => {
      const { run, calls } = await scenario(
        { ...(await withOidc()), apply: false },
        { bucket: true },
      );
      const readSecret = vi.fn(() => Promise.resolve(SECRET));

      await run({ readSecret });

      expect(readSecret).not.toHaveBeenCalled();
      expect(secretCalls(calls)).toEqual([]);
      expect(output).toContain('asks once for the client secret of https://accounts.example.com');
    });

    it('masks the secret in what a later step prints', async () => {
      const setup = await scenario(await withOidc());
      let applies = 0;
      const runner: ToolRunner = (invocation) => {
        // The fourth apply is the full one, after the foundation, the secret and Cloud SQL.
        if (commandLine(invocation).startsWith('terraform apply') && ++applies === 4) {
          return Promise.resolve({
            status: 1,
            stdout: '',
            stderr: `Error: rejected the value ${SECRET}\n`,
          });
        }
        return setup.runner(invocation);
      };

      await setup.run({ runner, readSecret: () => Promise.resolve(SECRET) }).catch(() => undefined);

      expect(applies).toBe(4);
      expect(output).not.toContain(SECRET);
      expect(output).toContain('rejected the value ***');
    });

    it('names the sign-in, the domain and the DNS record in the summary', async () => {
      const { run } = await scenario(await withOidc({ domain: 'agents.example.com' }), {
        loadBalancerIp: '203.0.113.7',
      });

      const outcome = await run({ readSecret: () => Promise.resolve(SECRET) });

      expect(outcome.nextSteps.slice(0, 3)).toEqual([
        'web: https://agents.example.com',
        'next: point agents.example.com at 203.0.113.7',
        'sign-in: single sign-on through https://accounts.example.com; the Owner password stays as a break-glass sign-in',
      ]);
    });

    it('writes domain, armor, iap and the oidc settings as Terraform variables, only when set', async () => {
      const { run, moduleDirectory } = await scenario(
        await withOidc({ domain: 'agents.example.com', armor: true, iap: false }),
      );

      await run({ readSecret: () => Promise.resolve(SECRET) });

      expect(
        JSON.parse(await readFile(path.join(moduleDirectory, 'terraform.tfvars.json'), 'utf8')),
      ).toEqual({
        project_id: PROJECT,
        region: REGION,
        name: 'acme-ai',
        vertex_location: 'global',
        domain: 'agents.example.com',
        armor: true,
        iap: false,
        oidc_issuer: oidc.issuer,
        oidc_client_id: oidc.clientId,
      });
    });
  });

  describe('variables', () => {
    it('writes data_protection, size and alerts_email when the project file sets them', async () => {
      const { run, moduleDirectory } = await scenario({
        project: await gcpProject('acme-ai', {
          dataProtection: false,
          size: 'standard',
          alertsEmail: 'ops@example.com',
        }),
      });

      await run();

      expect(
        JSON.parse(await readFile(path.join(moduleDirectory, 'terraform.tfvars.json'), 'utf8')),
      ).toEqual({
        project_id: PROJECT,
        region: REGION,
        name: 'acme-ai',
        vertex_location: 'global',
        data_protection: false,
        size: 'standard',
        alerts_email: 'ops@example.com',
      });
    });

    it('honours a hand-written terraform.tfvars without a gcp block, with a notice', async () => {
      const project = await gcpProject();
      const production = project.environments.production;
      if (production === undefined) throw new Error('no production');
      const legacy = { target: production.target, url: production.url };
      const { run, options, moduleDirectory, calls } = await scenario(
        {
          project: { ...project, environments: { ...project.environments, production: legacy } },
          env: {},
          apply: false,
        },
        { stack: true },
      );
      await materializeCloudRunModule(options.stateDirectory);
      await mkdir(path.join(moduleDirectory, '.terraform'), { recursive: true });
      await writeFile(
        path.join(moduleDirectory, 'terraform.tfvars'),
        `project_id = "${PROJECT}"\n`,
      );

      await run();

      expect(output).toContain('Using project_id from terraform.tfvars or TF_VAR_project_id');
      expect(await readdir(moduleDirectory)).not.toContain('terraform.tfvars.json');
      expect(calls.map(commandLine).some((line) => line.startsWith('gcloud storage'))).toBe(false);
    });

    it('refuses a legacy project_id that differs from the gcp block, naming both', async () => {
      const { run, options, moduleDirectory, calls, stateDirectory } = await scenario();
      await materializeCloudRunModule(options.stateDirectory);
      await writeFile(
        path.join(moduleDirectory, 'terraform.tfvars'),
        'project_id = "other-prod"\n',
      );

      const failure = run();

      await expect(failure).rejects.toThrow(
        'environments.production.gcp.project is "acme-prod" but the project_id (terraform.tfvars)',
      );
      await expect(failure).rejects.toThrow('"other-prod"');
      expect(
        calls.map(commandLine).some((line) => line.startsWith('gcloud storage buckets create')),
      ).toBe(false);
      await expect(access(path.join(stateDirectory, '.env'))).rejects.toThrow();
    });

    it('refuses a name that terraform.tfvars or TF_VAR_name sets beside the derived one', async () => {
      const tfvars = await scenario();
      await materializeCloudRunModule(tfvars.options.stateDirectory);
      await writeFile(
        path.join(tfvars.moduleDirectory, 'terraform.tfvars'),
        'name = "old-stack"\n',
      );
      await expect(tfvars.run()).rejects.toThrow('"old-stack"');

      const { run } = await scenario({ env: { TF_VAR_name: 'old-stack' } });
      const failure = run();
      await expect(failure).rejects.toThrow('the name (TF_VAR_name) is "old-stack"');
      await expect(failure).rejects.toThrow('Nothing was created.');
    });

    it('refuses a TF_VAR_project_id that differs from the gcp block', async () => {
      const { run } = await scenario({ env: { TF_VAR_project_id: 'other-prod' } });
      await expect(run()).rejects.toThrow('"other-prod"');
    });
  });

  it('leaves a --infra checkout untouched, passing the gcp block as variables', async () => {
    const checkout = await home();
    const module = path.join(checkout, 'terraform', 'gcp-cloudrun');
    await mkdir(path.join(module, '.terraform'), { recursive: true });
    await writeFile(path.join(module, 'main.tf'), '');
    const copied: DeploymentImages = {
      ...release,
      web: `${REGISTRY}/web@${digest('1')}`,
      gateway: `${REGISTRY}/gateway@${digest('2')}`,
      runner: `${REGISTRY}/runner@${digest('3')}`,
      runtime: `${REGISTRY}/runtime@${digest('4')}`,
    };
    const { run, calls } = await scenario(
      { infraDirectory: checkout, apply: false, images: copied },
      { stack: true },
    );
    const before = await readdir(module);

    await run();

    expect(await readdir(module)).toEqual(before);
    const lines = calls.map(commandLine);
    expect(lines.some((line) => line.startsWith('gcloud storage buckets'))).toBe(false);
    expect(lines.some((line) => line.startsWith('terraform init'))).toBe(false);
    const plan = calls.find((call) => commandLine(call).startsWith('terraform plan'));
    expect(plan?.env['TF_VAR_project_id']).toBe(PROJECT);
    expect(plan?.env['TF_VAR_region']).toBe(REGION);
  });

  it.each([
    [
      'terraform.tfvars',
      'project_id = "other-prod"\n',
      'project_id (terraform.tfvars) is "other-prod"',
    ],
    [
      'prod.auto.tfvars',
      'region = "europe-west1"\n',
      'region (prod.auto.tfvars) is "europe-west1"',
    ],
  ])(
    'refuses a --infra checkout whose %s names another project or region',
    async (file, text, message) => {
      const checkout = await home();
      const module = path.join(checkout, 'terraform', 'gcp-cloudrun');
      await mkdir(path.join(module, '.terraform'), { recursive: true });
      await writeFile(path.join(module, 'main.tf'), '');
      await writeFile(path.join(module, file), text);
      const { run, calls } = await scenario({ infraDirectory: checkout, apply: false });

      await expect(run()).rejects.toThrow(message);

      expect(calls.map(commandLine).some((line) => line.startsWith('terraform plan'))).toBe(false);
    },
  );

  it('keeps the registry formula equal to outputs.tf and the module default name', async () => {
    const module = new URL('../../../../infra/terraform/gcp-cloudrun/', import.meta.url);
    const outputs = await readFile(new URL('outputs.tf', module), 'utf8');
    const main = await readFile(new URL('main.tf', module), 'utf8');
    const variables = await readFile(new URL('variables.tf', module), 'utf8');

    expect(outputs).toContain(
      'value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"',
    );
    expect(main).toMatch(
      /resource "google_artifact_registry_repository" "images" \{[^}]*repository_id = var\.name/u,
    );
    expect(variables).toMatch(/variable "name" \{[^}]*default\s+=\s+"agent-workspace"/u);
    expect(expectedImageRegistry({ project: PROJECT, region: REGION }, 'acme-ai')).toBe(REGISTRY);
    expect(expectedImageRegistry({ project: PROJECT, region: REGION }, 'staging')).toBe(
      `${REGION}-docker.pkg.dev/${PROJECT}/staging`,
    );
  });
});

describe('aw deploy destroy production', () => {
  async function deployed(initial: Partial<World> = {}) {
    const setup = await scenario({}, initial);
    await setup.run();
    setup.calls.length = 0;
    output = '';
    const destroy = (typed: string) =>
      destroyProjectEnvironment({
        project: setup.options.project,
        environment: 'production',
        stateDirectory: setup.stateDirectory,
        runner: setup.runner,
        env: {},
        fetch: granted,
        confirm: (question) => {
          output += `${question}\n`;
          return Promise.resolve(typed);
        },
      });
    return { ...setup, destroy };
  }

  it('plans the destruction, summarises it and applies after the typed project id', async () => {
    const { destroy, calls } = await deployed();

    await destroy(PROJECT);

    const lines = calls.map(commandLine);
    const plan = lines.findIndex((line) => line.startsWith('terraform plan -destroy'));
    const apply = lines.findIndex((line) => line.startsWith('terraform apply'));
    expect(plan).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(plan);
    expect(lines.some((line) => line.startsWith('terraform init'))).toBe(false);
    expect(output).toContain('Type the Google Cloud project id to delete everything');
    expect(output).toContain('Plan summary');
    expect(output).toContain('cannot be deployed again in this Google Cloud project');
  });

  it.each([
    'Error: Error waiting for Deleting Network: resourceInUseByAnotherResource',
    "Error: The subnetwork resource 'projects/p/regions/r/subnetworks/s' is already being used by 'projects/p/regions/r/addresses/a'",
  ])('says the network is released later when it is still in use: %s', async (stderr) => {
    const { destroy, world } = await deployed();
    world.applyFails = `╷\n│ ${stderr}\n╵\n`;

    const failure = await destroy(PROJECT).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(failure).toContain(
      'Google Cloud releases the network 1–2 hours after its services are deleted; everything else is gone. Run aw deploy destroy production again after that.',
    );
    expect(failure).not.toContain('Data protection is on');
  });

  it('refuses a mismatched confirmation before anything is applied', async () => {
    const { destroy, calls } = await deployed();

    await expect(destroy('acme')).rejects.toThrow('Nothing was destroyed.');

    expect(calls.map(commandLine).some((line) => line.startsWith('terraform apply'))).toBe(false);
  });

  it('explains data protection when Terraform refuses to delete Cloud SQL', async () => {
    const { destroy, world } = await deployed();
    world.applyFails =
      '╷\n│ Error: Error, failed to delete instance because deletion_protection is set to true\n╵\n';

    const failure = await destroy(PROJECT).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(failure).toContain('Data protection is on');
    expect(failure).toContain('environments.production.gcp.dataProtection: false');
    expect(failure).not.toContain('TF_VAR_data_protection');
    expect(failure).toContain('aw deploy destroy production');
  });

  const planOf = (
    ...changes: readonly {
      readonly type: string;
      readonly before: Record<string, unknown>;
    }[]
  ) =>
    JSON.stringify({
      resource_changes: changes.map(({ type, before }) => ({
        address: `${type}.x`,
        type,
        change: { actions: ['delete'], before, after: null },
      })),
    });

  it.each([
    [
      'Cloud SQL still has deletion protection',
      planOf(
        { type: 'google_sql_database_instance', before: { deletion_protection: true } },
        { type: 'google_storage_bucket', before: { force_destroy: true } },
      ),
      'google_sql_database_instance.x (Cloud SQL instance)',
    ],
    [
      'a Cloud Run service has deletion protection',
      planOf({ type: 'google_cloud_run_v2_service', before: { deletion_protection: true } }),
      'google_cloud_run_v2_service.x (Cloud Run service)',
    ],
    [
      'a bucket does not force destroy',
      planOf({ type: 'google_storage_bucket', before: { force_destroy: false } }),
      'google_storage_bucket.x (storage bucket)',
    ],
  ])('stops before any apply when %s', async (_name, planJson, label) => {
    const { destroy, calls, world } = await deployed();
    world.planJson = planJson;

    await expect(destroy(PROJECT)).rejects.toThrow(label);

    expect(calls.map(commandLine).some((line) => line.startsWith('terraform apply'))).toBe(false);
    expect(output).not.toContain('Type the Google Cloud project id');
  });

  it('asks for the project id and applies when nothing is protected', async () => {
    const { destroy, calls, world } = await deployed();
    world.planJson = planOf(
      { type: 'google_sql_database_instance', before: { deletion_protection: false } },
      { type: 'google_cloud_run_v2_service', before: { deletion_protection: false } },
      { type: 'google_storage_bucket', before: { force_destroy: true } },
    );

    await destroy(PROJECT);

    expect(output).toContain('Type the Google Cloud project id');
    expect(calls.map(commandLine).some((line) => line.startsWith('terraform apply'))).toBe(true);
  });

  it('copies the images again after a destroy deleted the repository', async () => {
    const { destroy, run, calls, world } = await deployed();
    await destroy(PROJECT);
    world.stack = false;
    world.images.clear();
    calls.length = 0;

    await run();

    expect(
      calls.map(commandLine).filter((line) => line.includes('imagetools create')),
    ).toHaveLength(4);
  });

  it('refuses when the stack never used the managed state, as with --infra', async () => {
    const { run, options, moduleDirectory, calls } = await scenario(
      { apply: false },
      { bucket: true },
    );
    await run();
    await rm(path.join(moduleDirectory, '.aw-backend.json'), { force: true });
    calls.length = 0;

    const failure = destroyProjectEnvironment({
      project: options.project,
      environment: 'production',
      stateDirectory: options.stateDirectory,
      runner: options.runner ?? (() => Promise.reject(new Error('unused'))),
      env: {},
      fetch: granted,
      confirm: () => Promise.resolve(PROJECT),
    });

    await expect(failure).rejects.toThrow('there is nothing to destroy');
    expect(calls.map(commandLine).some((line) => /^terraform (init|plan|apply)/u.test(line))).toBe(
      false,
    );
  });

  it('refuses when nothing was deployed from this machine', async () => {
    const { options } = await scenario();
    await expect(
      destroyProjectEnvironment({
        project: options.project,
        environment: 'production',
        stateDirectory: options.stateDirectory,
        confirm: () => Promise.resolve(PROJECT),
      }),
    ).rejects.toThrow('Nothing was deployed from this machine');
  });
});

describe('summarisePlan', () => {
  const redact = createRedactor({ BOOTSTRAP_ADMIN_PASSWORD: 'plan-time-secret-value' });

  it('prints counts by action and kind, protection and the idle cost (golden)', async () => {
    const summary = summarisePlan(await fixture('plan.json'));

    expect(redact(summary)).toBe(await fixture('plan-summary.txt'));
  });

  it('prints the standard idle cost when the plan sets size standard', async () => {
    const plan: unknown = JSON.parse(await fixture('plan.json'));
    const standard = JSON.stringify({
      ...(plan as object),
      variables: { size: { value: 'standard' } },
    });

    const summary = summarisePlan(standard);

    expect(summary).toContain('Idle cost: standard: regional high-availability Cloud SQL');
    expect(summary).not.toContain('Idle cost: small');
  });

  it('flags a Cloud SQL replacement and a bucket deletion as protected', async () => {
    const summary = summarisePlan(await fixture('plan-protected.json'));

    expect(summary).toContain('0 to create, 1 to update, 1 to delete, 1 to replace');
    expect(summary).toContain(
      'PROTECTED: google_sql_database_instance.main (Cloud SQL instance) would be replaced; its data is lost',
    );
    expect(summary).toContain(
      'PROTECTED: google_storage_bucket.objects (storage bucket) would be deleted; its data is lost',
    );
  });

  it('refuses text that is not a plan', () => {
    expect(() => summarisePlan('not json')).toThrow('did not print a plan');
  });
});

describe('lifecycleStep', () => {
  it('prints the step and its elapsed time, and reports a failure with the re-run command', async () => {
    const lines: string[] = [];
    const context: DeployContext = {
      runner: () => Promise.reject(new Error('unused')),
      directory: '/project',
      env: {},
      cloud: 'gcp',
      out: (text) => lines.push(text),
      err: () => undefined,
    };

    await lifecycleStep(context, 'Step one', () => Promise.resolve());
    const failure = lifecycleStep(context, 'Step two', (step) => {
      step.err('╷\n│ Error: it broke postgres://ops:hunter22@db.example/aw\n╵\n');
      return Promise.reject(new Error('exit status 1'));
    });

    await expect(failure).rejects.toThrow('Step two failed after');
    await expect(failure).rejects.toThrow('Error: it broke postgres://***@db.example/aw');
    await expect(failure).rejects.toThrow('Run it again: aw deploy production --yes');
    expect(lines.join('')).toMatch(/Step one \.\.\.\nStep one: done in \d+ s\n/u);
  });

  it('masks the quoted error with the redactor it is given', async () => {
    const context: DeployContext = {
      runner: () => Promise.reject(new Error('unused')),
      directory: '/project',
      env: {},
      cloud: 'gcp',
      out: () => undefined,
      err: () => undefined,
    };

    const failure = lifecycleStep(
      context,
      'Plan and apply',
      (step) => {
        step.err('Error: the value S3cretPassw0rd-XYZ was refused\n');
        return Promise.reject(new Error('exit status 1'));
      },
      { redact: createRedactor({ SECRET: 'S3cretPassw0rd-XYZ' }) },
    );

    await expect(failure).rejects.toThrow('Error: the value *** was refused');
    await expect(failure).rejects.not.toThrow('S3cretPassw0rd');
  });

  it('quotes the thrown error, not an earlier warning, and re-runs a plan without --yes', async () => {
    const context: DeployContext = {
      runner: () => Promise.reject(new Error('unused')),
      directory: '/project',
      env: {},
      cloud: 'gcp',
      out: () => undefined,
      err: () => undefined,
    };

    const failure = lifecycleStep(
      context,
      'Check',
      (step) => {
        step.err('WARNING: org-policies describe failed\n');
        return Promise.reject(new Error('The Google Cloud checks failed.'));
      },
      { rerun: deployRerunCommand(false), quoteError: true },
    );

    await expect(failure).rejects.toThrow('failed after');
    await expect(failure).rejects.toThrow(/: The Google Cloud checks failed\./u);
    await expect(failure).rejects.not.toThrow('WARNING');
    await expect(failure).rejects.toThrow(/Run it again: aw deploy production$/u);
  });
});

describe('initialiseBackend', () => {
  async function initialised() {
    const moduleDirectory = path.join(await home(), 'module');
    await mkdir(moduleDirectory, { recursive: true });
    await writeFile(path.join(moduleDirectory, 'versions.tf'), 'required_version = ">= 1.8.0"\n');
    const calls: ToolInvocation[] = [];
    const context: DeployContext = {
      runner: async (invocation) => {
        calls.push(invocation);
        await mkdir(path.join(moduleDirectory, '.terraform'), { recursive: true });
        return ok();
      },
      directory: '/project',
      env: {},
      cloud: 'gcp',
      out: () => undefined,
      err: () => undefined,
    };
    const backend = backendFor({ project: PROJECT, region: REGION }, 'acme-ai');
    return { moduleDirectory, calls, context, backend };
  }

  it('runs init again, without -upgrade, when the module versions.tf changes between runs', async () => {
    const { moduleDirectory, calls, context, backend } = await initialised();

    expect(await initialiseBackend(context, moduleDirectory, backend)).toBe(true);
    expect(await initialiseBackend(context, moduleDirectory, backend)).toBe(false);
    await writeFile(
      path.join(moduleDirectory, 'versions.tf'),
      'required_version = ">= 1.8.0"\n# google ~> 7.0\n',
    );
    expect(await initialiseBackend(context, moduleDirectory, backend)).toBe(true);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toContain('-reconfigure');
    expect(calls[1]?.args).not.toContain('-upgrade');
    expect(await initialiseBackend(context, moduleDirectory, backend)).toBe(false);
  });

  it('runs init again, without -upgrade, when only the shipped lock file changes', async () => {
    const { moduleDirectory, calls, context, backend } = await initialised();
    const lock = path.join(moduleDirectory, '.terraform.lock.hcl');
    await writeFile(lock, '# lock 1\n');
    expect(await initialiseBackend(context, moduleDirectory, backend)).toBe(true);
    expect(await initialiseBackend(context, moduleDirectory, backend)).toBe(false);

    await writeFile(lock, '# lock 2\n');

    expect(await initialiseBackend(context, moduleDirectory, backend)).toBe(true);
    expect(calls[1]?.args).not.toContain('-upgrade');
  });

  it('refuses to start a second stack beside one initialised for another backend', async () => {
    const { moduleDirectory, calls, context, backend } = await initialised();
    await mkdir(path.join(moduleDirectory, '.terraform'), { recursive: true });
    await writeFile(
      path.join(moduleDirectory, '.terraform', 'terraform.tfstate'),
      JSON.stringify({ backend: { type: 'gcs', config: { bucket: 'old-state', prefix: 'prod' } } }),
    );

    const failure = initialiseBackend(context, moduleDirectory, backend);

    await expect(failure).rejects.toThrow('init -migrate-state');
    await expect(failure).rejects.toThrow(`-backend-config=bucket=${PROJECT}-aw-tfstate`);
    expect(calls).toHaveLength(0);
  });

  it('refuses a module directory that holds local state', async () => {
    const { moduleDirectory, calls, context, backend } = await initialised();
    await writeFile(
      path.join(moduleDirectory, 'terraform.tfstate'),
      JSON.stringify({ version: 4, resources: [{ type: 'google_kms_key_ring' }] }),
    );

    await expect(initialiseBackend(context, moduleDirectory, backend)).rejects.toThrow(
      'second one beside it',
    );
    expect(calls).toHaveLength(0);
  });

  it('accepts the empty local state that init -migrate-state leaves beside a managed backend', async () => {
    const { moduleDirectory, calls, context, backend } = await initialised();
    await mkdir(path.join(moduleDirectory, '.terraform'), { recursive: true });
    await writeFile(
      path.join(moduleDirectory, '.terraform', 'terraform.tfstate'),
      JSON.stringify({ backend: { type: 'gcs', config: backend } }),
    );
    await writeFile(
      path.join(moduleDirectory, 'terraform.tfstate'),
      JSON.stringify({ version: 4, serial: 3, resources: [] }),
    );

    expect(await initialiseBackend(context, moduleDirectory, backend)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('accepts a directory already initialised for the managed backend', async () => {
    const { moduleDirectory, context, backend } = await initialised();
    await mkdir(path.join(moduleDirectory, '.terraform'), { recursive: true });
    await writeFile(
      path.join(moduleDirectory, '.terraform', 'terraform.tfstate'),
      JSON.stringify({ backend: { type: 'gcs', config: backend } }),
    );

    expect(await initialiseBackend(context, moduleDirectory, backend)).toBe(true);
  });
});

describe('moduleResourceName', () => {
  it('keeps the service account ids it makes within the 30 characters Google allows', () => {
    const name = moduleResourceName('a-project-name-of-twenty-two-or-more');
    expect(name).toHaveLength(19);
    expect(`${name}-runner-mgr`.length).toBeLessThanOrEqual(30);
  });

  it('gives two long names with the same first 19 characters different names', () => {
    const first = moduleResourceName('acme-customer-support-bot');
    const second = moduleResourceName('acme-customer-support-dev');
    expect(first).not.toBe(second);
    expect(first).toMatch(/^acme-customer-[0-9a-f]{4}$/u);
    expect(moduleResourceName('x')).not.toBe(moduleResourceName('y'));
  });

  it.each([
    ['acme-ai', 'acme-ai'],
    ['a-very-long-project-name-indeed', 'a-very-long-pr-d863'],
    ['x', 'x-2d71'],
    ['9lives', 'agent-ws-bc86'],
  ])('derives the module name of project %s as %s', (projectName, expected) => {
    expect(moduleResourceName(projectName)).toBe(expected);
  });
});
