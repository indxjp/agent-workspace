import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseProjectFile } from '@indx-workspace/sdk/project';
import { describe, expect, it, vi } from 'vitest';

import { parseEnvironment, type DeploymentImages } from '../deployment.js';
import { PLATFORM_IMAGE_VERSION } from '../release-images.js';
import { appRoleSql } from './compose-apps.js';
import { CLOUD_RUN_MODULE_SOURCE, cloudRunModuleDirectory } from './cloud-run-module.js';
import { deployProjectEnvironment, type DeployProjectEnvironmentOptions } from './project.js';
import type { ToolInvocation, ToolResult, ToolRunner } from './runner.js';
import {
  captured,
  capturedFailure,
  digest,
  fixture,
  isApply,
  stubRunner,
  temporaryDirectory,
  type Respond,
} from './deploy.test-support.js';

const registry = 'asia-northeast1-docker.pkg.dev/acme-prod/agent-workspace';
const release: DeploymentImages = {
  web: `ghcr.io/indxdev/web@${digest('1')}`,
  gateway: `ghcr.io/indxdev/gateway@${digest('2')}`,
  runner: `ghcr.io/indxdev/runner@${digest('3')}`,
  runtime: `ghcr.io/indxdev/runtime-claude-agent-sdk@${digest('4')}`,
  toolHost: `ghcr.io/indxdev/tool-host@${digest('5')}`,
};
const copied: DeploymentImages = {
  web: `${registry}/web@${digest('1')}`,
  gateway: `${registry}/gateway@${digest('2')}`,
  runner: `${registry}/runner@${digest('3')}`,
  runtime: `${registry}/runtime@${digest('4')}`,
  toolHost: `${registry}/tool-host@${digest('5')}`,
};

interface Scenario {
  /** The module was `terraform init`ed. */
  readonly initialised?: boolean;
  /** What `terraform output -raw image_registry` answers; `null` is a module with no repository yet. */
  readonly registryOutput?: string | null;
  /** What `terraform output` prints on stderr when `registryOutput` is `null`. */
  readonly registryStderr?: string;
  readonly copyStatus?: number;
  /** The digest `imagetools inspect` reports instead of the copy's own. */
  readonly inspectedDigest?: string;
  readonly apply?: boolean;
  readonly images?: DeploymentImages;
  /** `environments.production.apps`. */
  readonly apps?: Record<string, { image: string; url: string }>;
  /** The `<registry>/<name>@<digest>` references the registry holds; copies add to it. */
  readonly present?: Set<string>;
}

/** Terraform answers: the registry output, or the error of a module with no repository. */
function terraformAnswer(args: readonly string[], scenario: Scenario): Partial<ToolResult> {
  const { registryOutput = registry, registryStderr = 'Error: Output "image_registry" not found' } =
    scenario;
  if (args[1] === 'plan') return { status: 2 };
  if (args[1] !== 'output') return {};
  return registryOutput === null
    ? { status: 1, stderr: registryStderr }
    : { stdout: `${registryOutput}\n` };
}

/** `docker buildx imagetools create`: copies a release image into the registry, or is denied. */
function copyAnswer(args: readonly string[], scenario: Scenario): Partial<ToolResult> {
  const { copyStatus = 0, present } = scenario;
  if (copyStatus !== 0) return { status: copyStatus, stderr: 'denied: permission' };
  const [tagged = '', source = ''] = args.slice(4);
  present?.add(`${tagged.slice(0, tagged.lastIndexOf(':'))}${source.slice(source.indexOf('@'))}`);
  return {};
}

/** `docker buildx imagetools inspect`: the digest of a reference the registry holds. */
function inspectAnswer(args: readonly string[], scenario: Scenario): Partial<ToolResult> {
  const reference = args[3] ?? '';
  if (!scenario.present?.has(reference)) return { status: 1, stderr: `${reference}: not found` };
  const digestOfCopy = reference.slice(reference.indexOf('@') + 1);
  return { stdout: JSON.stringify({ digest: scenario.inspectedDigest ?? digestOfCopy }) };
}

function cloudRunResponder(scenario: Scenario): Respond {
  return ({ tool, args }) => {
    if (tool === 'terraform') return terraformAnswer(args, scenario);
    if (tool !== 'docker') return {};
    if (args[2] === 'create') return copyAnswer(args, scenario);
    if (args[2] === 'inspect') return inspectAnswer(args, scenario);
    return {};
  };
}

/** The project and runner of one scenario; the module is the one the CLI ships. */
async function scenario(given: Scenario = {}) {
  const {
    initialised = true,
    apply = false,
    images = release,
    present = new Set<string>(),
    apps,
  } = given;
  const read = parseProjectFile(await fixture('production-gcp-cloudrun.project.yaml'));
  if (read.lifted) throw new Error('production-gcp-cloudrun.project.yaml is not a v2 project');
  const home = await temporaryDirectory();
  const stateDirectory = path.join(home, 'deployments', 'acme-ai', 'production');
  const moduleDirectory = cloudRunModuleDirectory(stateDirectory);
  const stub = stubRunner(cloudRunResponder({ ...given, present }));
  const { calls } = stub;
  // cosign is not on PATH here: a missing tool rejects with ENOENT, which the copy reports and continues.
  const runner: ToolRunner = (invocation) =>
    invocation.tool === 'cosign'
      ? Promise.reject(Object.assign(new Error('spawn cosign ENOENT'), { code: 'ENOENT' }))
      : stub.runner(invocation);
  const production = read.project.environments.production;
  if (production === undefined) throw new Error('the fixture has a production environment');
  const project =
    apps === undefined
      ? read.project
      : {
          ...read.project,
          environments: { ...read.project.environments, production: { ...production, apps } },
        };
  const options: DeployProjectEnvironmentOptions = {
    project,
    environment: 'production',
    apply,
    stateDirectory,
    env: { TF_VAR_project_id: 'acme-prod' },
    images,
    nodeVersion: '24.1.0',
    runner,
  };
  if (initialised) {
    // Stands for `terraform init`, which the Owner runs in the module the deploy writes.
    await mkdir(path.join(moduleDirectory, '.terraform'), { recursive: true });
  }
  return { options, runner, calls, stateDirectory, moduleDirectory, present };
}

const isImageCopy = ({ tool, args }: ToolInvocation) => tool === 'docker' && args[2] === 'create';
const isDocker = ({ tool }: ToolInvocation) => tool === 'docker';

function planCases(): void {
  it('writes the shipped module beside the state and asks for terraform init, before anything is created', async () => {
    const { options, calls, stateDirectory, moduleDirectory } = await scenario({
      initialised: false,
    });

    const { message } = await capturedFailure(() => deployProjectEnvironment(options));

    expect(message).toContain(`terraform -chdir=${moduleDirectory} init`);
    expect(await readdir(moduleDirectory)).toEqual(
      expect.arrayContaining(await readdir(CLOUD_RUN_MODULE_SOURCE)),
    );
    expect(calls.filter((call) => isDocker(call) || isApply(call))).toEqual([]);
    await expect(access(stateDirectory)).rejects.toThrow();
  });

  it('plans in the written module when the images are already in Artifact Registry', async () => {
    const { options, calls, moduleDirectory } = await scenario({ images: copied });

    const { result } = await captured(() => deployProjectEnvironment(options));

    expect(result).toMatchObject({ changes: true, applied: false, created: true, moduleDirectory });
    expect(calls.find(({ args }) => args[1] === 'plan')?.args[0]).toBe(`-chdir=${moduleDirectory}`);
    expect(calls.filter((call) => isDocker(call) || isApply(call))).toEqual([]);
  });

  it('lists the pending copies in a plan, copies nothing and creates no state', async () => {
    const { options, calls, stateDirectory } = await scenario();

    const { result, output } = await captured(() => deployProjectEnvironment(options));

    expect(result).toMatchObject({ changes: true, applied: false, created: false });
    expect(output).toContain(`Would copy ${release.web} to ${copied.web}`);
    expect(output).toContain(`Would copy ${release.runtime} to ${copied.runtime}`);
    expect(calls.filter((call) => isImageCopy(call) || isApply(call))).toEqual([]);
    expect(calls.map(({ args }) => args[1])).not.toContain('plan');
    await expect(access(stateDirectory)).rejects.toThrow();
  });
}

function copyCases(): void {
  it('copies each image by digest on the first --yes, then stops before Terraform (ADR-0094)', async () => {
    const { options, calls, stateDirectory } = await scenario({ apply: true });

    const { result, output } = await captured(() => deployProjectEnvironment(options));

    expect(result).toMatchObject({ changes: true, applied: false, created: false });
    expect(output).toContain('Images copied. Run --plan to review, then --yes.');
    const copies = calls.filter(isImageCopy);
    expect(copies.map(({ args }) => args)).toEqual(
      (
        [
          ['web', 'web'],
          ['gateway', 'gateway'],
          ['runner', 'runner'],
          ['runtime', 'runtime'],
          ['tool-host', 'toolHost'],
        ] as const
      ).map(([repository, name]) => [
        'buildx',
        'imagetools',
        'create',
        '--tag',
        `${registry}/${repository}:${PLATFORM_IMAGE_VERSION}`,
        release[name],
      ]),
    );
    for (const { args } of copies) expect(args.at(-1)).toMatch(/@sha256:[0-9a-f]{64}$/u);
    // Each destination is inspected once to find it pending, then once to check its copy.
    const destinations = [
      copied.web,
      copied.gateway,
      copied.runner,
      copied.runtime,
      copied.toolHost,
    ];
    expect(
      calls
        .filter(({ tool, args }) => tool === 'docker' && args[2] === 'inspect')
        .map(({ args }) => args[3]),
    ).toEqual([...destinations, ...destinations]);
    expect(calls.map(({ args }) => args[1])).not.toContain('plan');
    expect(calls.filter(isApply)).toEqual([]);
    await expect(access(stateDirectory)).rejects.toThrow();
  });

  it('refuses a copy whose digest is not the release digest', async () => {
    const { options, calls } = await scenario({ apply: true, inspectedDigest: digest('f') });

    const { message } = await capturedFailure(() => deployProjectEnvironment(options));

    expect(message).toContain("is not the release's digest after the copy");
    expect(calls.filter(isApply)).toEqual([]);
  });
}

const DESK = {
  image: `ghcr.io/acme/desk@${digest('d')}`,
  url: 'https://desk.acme.example',
};
const deskCopy = `${registry}/app-desk@${digest('d')}`;

function appCases(): void {
  it('copies an app image into app-<name> by digest with --yes, beside the tool host', async () => {
    const { options, calls } = await scenario({ apply: true, apps: { desk: DESK } });

    await captured(() => deployProjectEnvironment(options));

    const copies = calls.filter(isImageCopy).map(({ args }) => args);
    expect(copies).toContainEqual([
      'buildx',
      'imagetools',
      'create',
      '--tag',
      `${registry}/app-desk:${PLATFORM_IMAGE_VERSION}`,
      DESK.image,
    ]);
    expect(copies).toContainEqual([
      'buildx',
      'imagetools',
      'create',
      '--tag',
      `${registry}/tool-host:${PLATFORM_IMAGE_VERSION}`,
      release.toolHost,
    ]);
    expect(copies).toHaveLength(6);
  });

  it('only lists the app and tool-host copies without --yes', async () => {
    const { options, calls } = await scenario({ apps: { desk: DESK } });

    const { output } = await captured(() => deployProjectEnvironment(options));

    expect(output).toContain(`Would copy ${DESK.image} to ${deskCopy}`);
    expect(output).toContain(`Would copy ${release.toolHost} to ${copied.toolHost}`);
    expect(calls.filter(isImageCopy)).toEqual([]);
  });

  it('hands the copied app to the plan as TF_VAR_apps, with the role SQL', async () => {
    const { options, calls } = await scenario({
      images: copied,
      apps: { desk: { ...DESK, image: deskCopy } },
    });

    await captured(() => deployProjectEnvironment(options));

    const plan = calls.find(({ args }) => args[1] === 'plan');
    const apps = JSON.parse(plan?.env['TF_VAR_apps'] ?? 'null') as Record<string, unknown>;
    const expectedRoleSql = appRoleSql('app_desk', '$$');
    expect(apps).toEqual({ desk: { image: deskCopy, url: DESK.url, role_sql: expectedRoleSql } });
  });
}

function planThenApplyCase(): void {
  it('plans once the copies are present, then applies the copies on the next --yes', async () => {
    const first = await scenario({ apply: true });
    await captured(() => deployProjectEnvironment(first.options));

    const plan = await scenario({ present: first.present });
    const planned = await captured(() =>
      deployProjectEnvironment({ ...plan.options, stateDirectory: first.stateDirectory }),
    );
    expect(planned.result).toMatchObject({ changes: true, applied: false, created: true });
    expect(plan.calls.filter((call) => isImageCopy(call) || isApply(call))).toEqual([]);
    expect(plan.calls.map(({ args }) => args[1])).toContain('plan');
    const variables = await readFile(
      path.join(first.stateDirectory, 'deploy', 'terraform', 'gcp-cloudrun.auto.tfvars.json'),
      'utf8',
    );
    const { toolHost, ...platform } = copied;
    expect(JSON.parse(variables)).toMatchObject({
      images: { ...platform, tool_host: toolHost },
    });

    const second = stubRunner(({ args }) => (args[1] === 'plan' ? { status: 2 } : {}));
    await captured(() => deployProjectEnvironment({ ...first.options, runner: second.runner }));

    expect(second.calls.filter(isDocker)).toEqual([]);
    expect(second.calls.some(({ args }) => args.includes('image_registry'))).toBe(false);
    expect(second.calls.map(({ args }) => args[1])).toContain('apply');
    const env = parseEnvironment(await readFile(path.join(first.stateDirectory, '.env'), 'utf8'));
    expect(env['WEB_IMAGE']).toBe(copied.web);
  });
}

function failedCopyCase(): void {
  it('refuses a failed copy with the exact commands, before anything is created or applied', async () => {
    const { options, calls, stateDirectory } = await scenario({ apply: true, copyStatus: 1 });

    const { message } = await capturedFailure(() => deployProjectEnvironment(options));

    expect(message).toContain(
      `docker buildx imagetools create --tag ${registry}/web:${PLATFORM_IMAGE_VERSION} ${release.web}`,
    );
    expect(message).toContain('gcloud auth configure-docker asia-northeast1-docker.pkg.dev');
    expect(calls.filter(isApply)).toEqual([]);
    await expect(access(stateDirectory)).rejects.toThrow();
  });
}

/** A runner whose image copies start at once but finish only when `release` is called. */
function heldCopies(inner: ToolRunner, failing?: string) {
  const started: string[] = [];
  const finished: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner: ToolRunner = async (invocation) => {
    if (!isImageCopy(invocation)) return inner(invocation);
    const name = invocation.args[4] ?? '';
    started.push(name);
    if (name.includes(`/${failing ?? ''}:`) && failing !== undefined) {
      finished.push(name);
      return { status: 1, stdout: '', stderr: 'denied: permission\n' };
    }
    await gate;
    finished.push(name);
    return inner(invocation);
  };
  return { runner, started, finished, release };
}

function concurrentCopyCases(): void {
  it('starts every image copy before any finishes, then verifies each destination', async () => {
    const { options, runner, calls } = await scenario({ apply: true });
    const held = heldCopies(runner);

    const run = captured(() => deployProjectEnvironment({ ...options, runner: held.runner }));
    await vi.waitFor(() => expect(held.started).toHaveLength(5));
    expect(held.finished).toEqual([]);
    held.release();
    const { output } = await run;

    for (const name of ['web', 'gateway', 'runner', 'runtime', 'tool-host']) {
      expect(output).toContain(`Copied ${name}.`);
    }
    expect(output).toContain('Images copied. Run --plan to review, then --yes.');
    const destinations = [
      copied.web,
      copied.gateway,
      copied.runner,
      copied.runtime,
      copied.toolHost,
    ];
    const inspected = calls
      .filter(({ tool, args }) => tool === 'docker' && args[2] === 'inspect')
      .map(({ args }) => args[3]);
    expect(inspected).toHaveLength(10);
    expect(inspected.slice(5).sort()).toEqual([...destinations].sort());
  });

  it('waits for the other copies when one fails, then lists every command', async () => {
    const { options, runner, calls, stateDirectory } = await scenario({ apply: true });
    const held = heldCopies(runner, 'web');

    let settled = false;
    const run = capturedFailure(() =>
      deployProjectEnvironment({ ...options, runner: held.runner }),
    ).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(held.started).toHaveLength(5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    held.release();
    const { message } = await run;

    expect(held.finished).toHaveLength(5);
    expect(message).toContain('Could not copy the release images');
    expect(message).toContain('`docker buildx` failed (exit status 1)');
    for (const [repository, name] of [
      ['web', 'web'],
      ['gateway', 'gateway'],
      ['runner', 'runner'],
      ['runtime', 'runtime'],
      ['tool-host', 'toolHost'],
    ] as const) {
      expect(message).toContain(
        `docker buildx imagetools create --tag ${registry}/${repository}:${PLATFORM_IMAGE_VERSION} ${release[name]}`,
      );
    }
    expect(calls.filter(isApply)).toEqual([]);
    await expect(access(stateDirectory)).rejects.toThrow();
  });
}

function missingRepositoryCases(): void {
  it('names the one command that creates the repository when the module has none', async () => {
    const { options, calls, moduleDirectory } = await scenario({
      apply: true,
      registryOutput: null,
    });

    const { message } = await capturedFailure(() => deployProjectEnvironment(options));

    expect(message).toContain(
      `terraform -chdir=${moduleDirectory} apply -target=google_artifact_registry_repository.images`,
    );
    expect(message).toContain('-var bootstrap_admin_email=owner@acme.example');
    expect(message).toContain(`web="${release.web}"`);
    expect(calls.filter((call) => isImageCopy(call) || isApply(call))).toEqual([]);
  });

  it("reports Terraform's own error, redacted, when output fails for another reason", async () => {
    const { options, calls } = await scenario({
      apply: true,
      registryOutput: null,
      registryStderr:
        '╷\n│ Error: Failed to get existing workspaces: querying Cloud Storage failed: ' +
        'postgres://ops:hunter22@db.example/aw\n│ \n╵\n',
    });

    const { message } = await capturedFailure(() => deployProjectEnvironment(options));

    expect(message).toContain('Error: Failed to get existing workspaces');
    expect(message).not.toContain('hunter22');
    expect(message).not.toContain('apply -target');
    expect(calls.filter((call) => isImageCopy(call) || isApply(call))).toEqual([]);
  });
}

describe('aw deploy to Cloud Run without --infra (#794)', () => {
  planCases();
  copyCases();
  appCases();
  planThenApplyCase();
  failedCopyCase();
  concurrentCopyCases();
  missingRepositoryCases();
});
