import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseProjectFile } from '@indx-workspace/sdk/project';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createWorkspace, DEFAULT_ANSWERS } from '../create.js';
import { parseEnvironment, type DeploymentImages } from '../deployment.js';
import type { DeploymentCloud } from '../profile.js';
import { PLATFORM_IMAGE_VERSION } from '../release-images.js';
import { CLOUD_RUN_MODULE_SOURCE, cloudRunModuleDirectory } from './cloud-run-module.js';
import { isWorkerPropagating } from './cloudflare.js';
import { runDeployCommand } from './command.js';
import { compareComposeServices, parseContainers, parseServiceHashes } from './compose.js';
import { hasDiffPlugin, summarizeManifests } from './helm.js';
import { deployProjectEnvironment, type DeployProjectEnvironmentOptions } from './project.js';
import type { ToolInvocation, ToolResult, ToolRunner } from './runner.js';

const created: string[] = [];
const toolHostTemplate = 'aw-tool-host:223e4567-e89b-42d3-a456-426614174111';
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const platformImages: DeploymentImages = {
  web: `registry.example/web@${digest('1')}`,
  gateway: `registry.example/gateway@${digest('2')}`,
  runner: `registry.example/runner@${digest('3')}`,
  runtime: `registry.example/runtime@${digest('4')}`,
};
const composeImages: DeploymentImages = {
  ...platformImages,
  postgres: `registry.example/postgres@${digest('5')}`,
  seaweedfs: `registry.example/seaweedfs@${digest('6')}`,
};
/** No `AW_*_IMAGE` override: every image comes from the project's own `.env` pins. */
const environment = {};

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-deploy-test-'));
  created.push(directory);
  return directory;
}

async function project(cloud: DeploymentCloud): Promise<string> {
  const target = path.join(await temporaryDirectory(), 'acme-ai');
  await createWorkspace(target, cloud === 'local' ? DEFAULT_ANSWERS : null, {
    cloud,
    images: cloud === 'local' ? composeImages : platformImages,
  });
  return target;
}

/** An `infra/` with an initialised module for each cloud and the chart's directory. */
async function infra(): Promise<string> {
  const directory = await temporaryDirectory();
  for (const module of ['gcp-cloudrun', 'azure-container-apps']) {
    await mkdir(path.join(directory, 'terraform', module, '.terraform'), { recursive: true });
  }
  await mkdir(path.join(directory, 'helm', 'agent-workspace'), { recursive: true });
  return directory;
}

/** The `.env` credentials a tool could echo, which no output may contain. */
async function secretsOf(target: string): Promise<readonly string[]> {
  const env = parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'));
  const secrets = [
    env['SESSION_SECRET'],
    env['GATEWAY_TOKEN_SECRET'],
    env['RUNNER_MANAGER_TOKEN'],
    env['BOOTSTRAP_ADMIN_PASSWORD'],
    env['DATABASE_URL'],
    env['POSTGRES_PASSWORD'],
  ].filter((value): value is string => value !== undefined && value.length >= 4);
  expect(secrets.length).toBeGreaterThanOrEqual(3);
  return secrets;
}

type Respond = (invocation: ToolInvocation) => Partial<ToolResult>;

/** A runner that records every invocation and answers from `respond`; nothing real is spawned. */
function stubRunner(respond: Respond): { runner: ToolRunner; calls: ToolInvocation[] } {
  const calls: ToolInvocation[] = [];
  const runner: ToolRunner = (invocation) => {
    calls.push(invocation);
    return Promise.resolve({ status: 0, stdout: '', stderr: '', ...respond(invocation) });
  };
  return { runner, calls };
}

/** Everything written to stdout and stderr while `run` ran. */
async function captured<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
  const written: string[] = [];
  const capture = (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  try {
    return { result: await run(), output: written.join('') };
  } finally {
    vi.restoreAllMocks();
  }
}

async function capturedFailure(
  run: () => Promise<unknown>,
): Promise<{ message: string; output: string }> {
  let message = '';
  const { output } = await captured(async () => {
    try {
      await run();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
  });
  expect(message).not.toBe('');
  return { message, output };
}

/** `docker compose up`, `helm upgrade` or `terraform apply`: a call that changes a deployment. */
function isApply({ tool, args }: ToolInvocation): boolean {
  if (tool === 'docker') return args[0] === 'compose' && args[1] === 'up';
  if (tool === 'helm') return args[0] === 'upgrade';
  return args[1] === 'apply';
}

/** Docker answers for a project whose `web` service is out of date. */
const composeResponder =
  (changed: boolean, echo = ''): Respond =>
  ({ args }) => {
    if (args.includes('--hash')) return { stdout: 'postgres aaa\nweb bbb\n' };
    if (args[0] === 'ps') {
      return {
        stdout: `postgres\taaa\trunning\nweb\t${changed ? 'old' : 'bbb'}\trunning\n`,
      };
    }
    return { stdout: echo, stderr: echo };
  };

/** Terraform answers: `plan` reports changes (2) or none (0). */
const terraformResponder =
  (changed: boolean, echo = ''): Respond =>
  ({ args }) =>
    args.includes('plan')
      ? { status: changed ? 2 : 0, stdout: `Plan: ${echo}\n`, stderr: echo }
      : { stdout: `Apply complete! ${echo}\n` };

const helmResponder =
  (withDiff: boolean, echo = ''): Respond =>
  ({ args }) => {
    if (args[0] === 'plugin') {
      return { stdout: `NAME\tVERSION\tDESCRIPTION\n${withDiff ? 'diff\t3.9.0\tPreview\n' : ''}` };
    }
    if (args[0] === 'diff') return { status: 2, stdout: `+ image ${echo}\n` };
    if (args[0] === 'template') {
      return {
        stdout:
          '---\n# Source: c/templates/web.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n' +
          `---\napiVersion: v1\nkind: Service\nmetadata:\n  name: web\n  annotations:\n    x: ${echo}\n`,
      };
    }
    return { stdout: `Release upgraded ${echo}\n` };
  };

describe('agent-workspace deploy without --yes', () => {
  it.each([
    ['local', composeResponder(true), []],
    ['aws', helmResponder(true), []],
    ['aws', helmResponder(false), []],
    ['gcp', terraformResponder(true), []],
    ['gcp', helmResponder(true), ['--target', 'helm']],
    ['azure', terraformResponder(true), []],
  ] as const)(
    'makes no apply or up call for a %s profile, and reports the changes',
    async (cloud, respond, extra) => {
      const target = await project(cloud);
      const { runner, calls } = stubRunner(respond);
      const infraArguments = cloud === 'local' ? [] : ['--infra', await infra()];

      const { result, output } = await captured(() =>
        runDeployCommand([target, ...infraArguments, ...extra], { runner, environment }),
      );

      expect(calls.length).toBeGreaterThan(0);
      expect(calls.filter(isApply)).toEqual([]);
      expect(result).toEqual({ changes: true, applied: false });
      expect(output).toContain('Re-run with --yes');
      for (const call of calls) expect(call.cwd).toBe(target);
    },
  );

  it('reports no changes for a current Compose project', async () => {
    const target = await project('local');
    const { runner, calls } = stubRunner(composeResponder(false));

    const { result, output } = await captured(() =>
      runDeployCommand([target], { runner, environment }),
    );

    expect(result).toEqual({ changes: false, applied: false });
    expect(output).toMatch(/web\s+unchanged/u);
    expect(output).toContain('No changes');
    expect(calls.filter(isApply)).toEqual([]);
  });
});

describe('agent-workspace deploy --yes', () => {
  it('prints the Terraform plan first and applies exactly the plan file it wrote', async () => {
    const target = await project('gcp');
    const infraDirectory = await infra();
    const { runner, calls } = stubRunner(terraformResponder(true));
    let planFileExistedAtApply = false;
    const checking: ToolRunner = async (invocation) => {
      if (invocation.args.includes('apply')) {
        const planFile = invocation.args.at(-1) ?? '';
        planFileExistedAtApply = await access(path.dirname(planFile)).then(
          () => true,
          () => false,
        );
      }
      return runner(invocation);
    };

    const { result, output } = await captured(async () =>
      runDeployCommand([target, '--yes', '--infra', infraDirectory], {
        runner: checking,
        environment,
      }),
    );

    expect(result).toEqual({ changes: true, applied: true });
    expect(calls.map(({ args }) => args[1])).toEqual(['plan', 'apply']);
    const [plan, apply] = calls;
    const out = plan?.args.find((argument) => argument.startsWith('-out='))?.slice('-out='.length);
    expect(out).toBeDefined();
    expect(apply?.args.at(-1)).toBe(out);
    expect(plan?.args).toContain(
      `-var-file=${path.join(target, 'deploy/terraform/gcp-cloudrun.auto.tfvars.json')}`,
    );
    expect(plan?.args[0]).toMatch(/^-chdir=.*terraform[/\\]gcp-cloudrun$/u);
    expect(output.indexOf('Plan:')).toBeLessThan(output.indexOf('Apply complete!'));
    expect(planFileExistedAtApply).toBe(true);
    await expect(access(path.dirname(out ?? ''))).rejects.toThrow();
  });

  it('skips the apply when the plan has no changes', async () => {
    const target = await project('azure');
    const infraDirectory = await infra();
    const { runner, calls } = stubRunner(terraformResponder(false));

    const { result } = await captured(async () =>
      runDeployCommand([target, '--yes', '--infra', infraDirectory], { runner, environment }),
    );

    expect(result).toEqual({ changes: false, applied: false });
    expect(calls.filter(isApply)).toEqual([]);
  });

  it('runs docker compose up for a local profile with changes', async () => {
    const target = await project('local');
    const { runner, calls } = stubRunner(composeResponder(true));

    const { result, output } = await captured(() =>
      runDeployCommand([target, '-y'], { runner, environment }),
    );

    expect(result).toEqual({ changes: true, applied: true });
    expect(calls.at(-1)?.args).toEqual(['compose', 'up', '--detach']);
    expect(output).toMatch(/web\s+recreate/u);
  });

  it('upgrades the release with the flavour file and the rendered overlay', async () => {
    const target = await project('aws');
    const infraDirectory = await infra();
    const { runner, calls } = stubRunner(helmResponder(true));

    await captured(() =>
      runDeployCommand([target, '--yes', '--infra', infraDirectory], { runner, environment }),
    );

    const chart = path.join(infraDirectory, 'helm', 'agent-workspace');
    expect(calls.at(-1)?.args).toEqual([
      'upgrade',
      '--install',
      'agent-workspace',
      chart,
      '--namespace',
      'agent-workspace',
      '-f',
      path.join(chart, 'values-eks.yaml'),
      '-f',
      path.join(target, 'deploy/helm/values.yaml'),
      '--create-namespace',
      '--wait',
    ]);
  });

  it('runs every docker compose call for the project .env names, not a shell-level one', async () => {
    const target = await project('local');
    const name = parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'))[
      'COMPOSE_PROJECT_NAME'
    ];
    expect(name).toBeDefined();
    const { runner, calls } = stubRunner(composeResponder(true));

    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: { COMPOSE_PROJECT_NAME: 'some-other-project' },
      }),
    );

    const compose = calls.filter(({ args }) => args[0] === 'compose');
    expect(compose.map(({ args }) => args[1])).toEqual(['config', 'config', 'up']);
    for (const call of compose) expect(call.env['COMPOSE_PROJECT_NAME']).toBe(name);
    const listed = calls.find(({ args }) => args[0] === 'ps');
    expect(listed?.args).toContain(`label=com.docker.compose.project=${name ?? ''}`);
  });
});

describe('the Terraform plan directory', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'is removed on %s, which is then re-raised',
    async (signal) => {
      const target = await project('gcp');
      const infraDirectory = await infra();
      const before = process.listeners(signal);
      const killed: (readonly [number, string | number | undefined])[] = [];
      vi.spyOn(process, 'kill').mockImplementation((pid, raised) => {
        killed.push([pid, raised]);
        return true;
      });
      let planDirectory = '';
      let removedOnSignal = false;
      const runner: ToolRunner = async ({ args }) => {
        const out = args.find((argument) => argument.startsWith('-out='));
        if (out !== undefined) {
          planDirectory = path.dirname(out.slice('-out='.length));
          await writeFile(path.join(planDirectory, 'plan.tfplan'), 'plain-text variables');
          const added = process.listeners(signal).filter((listener) => !before.includes(listener));
          expect(added).toHaveLength(1);
          for (const listener of added) listener(signal);
          removedOnSignal = await access(planDirectory).then(
            () => false,
            () => true,
          );
        }
        return { status: 0, stdout: '', stderr: '' };
      };

      await captured(() =>
        runDeployCommand([target, '--infra', infraDirectory], { runner, environment }),
      );

      expect(planDirectory).not.toBe('');
      expect(removedOnSignal).toBe(true);
      expect(killed).toEqual([[process.pid, signal]]);
      expect(process.listeners(signal)).toEqual(before);
    },
  );

  it('leaves no signal listener behind after a normal run', async () => {
    const target = await project('azure');
    const infraDirectory = await infra();
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const { runner } = stubRunner(terraformResponder(true));

    await captured(() =>
      runDeployCommand([target, '--yes', '--infra', infraDirectory], { runner, environment }),
    );

    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });
});

describe('aw deploy to Cloud Run without --infra (#794)', () => {
  const registry = 'asia-northeast1-docker.pkg.dev/acme-prod/agent-workspace';
  const release: DeploymentImages = {
    web: `ghcr.io/indxdev/web@${digest('1')}`,
    gateway: `ghcr.io/indxdev/gateway@${digest('2')}`,
    runner: `ghcr.io/indxdev/runner@${digest('3')}`,
    runtime: `ghcr.io/indxdev/runtime-claude-agent-sdk@${digest('4')}`,
  };
  const copied: DeploymentImages = {
    web: `${registry}/web@${digest('1')}`,
    gateway: `${registry}/gateway@${digest('2')}`,
    runner: `${registry}/runner@${digest('3')}`,
    runtime: `${registry}/runtime@${digest('4')}`,
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
    /** The `<registry>/<name>@<digest>` references the registry holds; copies add to it. */
    readonly present?: Set<string>;
  }

  /** The project and runner of one scenario; the module is the one the CLI ships. */
  async function scenario({
    initialised = true,
    registryOutput = registry,
    registryStderr = 'Error: Output "image_registry" not found',
    copyStatus = 0,
    inspectedDigest,
    apply = false,
    images = release,
    present = new Set<string>(),
  }: Scenario = {}) {
    const read = parseProjectFile(await fixture('production-gcp-cloudrun.project.yaml'));
    if (read.lifted) throw new Error('production-gcp-cloudrun.project.yaml is not a v2 project');
    const home = await temporaryDirectory();
    const stateDirectory = path.join(home, 'deployments', 'acme-ai', 'production');
    const moduleDirectory = cloudRunModuleDirectory(stateDirectory);
    const { runner, calls } = stubRunner(({ tool, args }) => {
      if (tool === 'terraform' && args[1] === 'output') {
        return registryOutput === null
          ? { status: 1, stderr: registryStderr }
          : { stdout: `${registryOutput}\n` };
      }
      if (tool === 'terraform' && args[1] === 'plan') return { status: 2 };
      if (tool === 'docker' && args[2] === 'create') {
        if (copyStatus !== 0) return { status: copyStatus, stderr: 'denied: permission' };
        const [tagged = '', source = ''] = args.slice(4);
        present.add(
          `${tagged.slice(0, tagged.lastIndexOf(':'))}${source.slice(source.indexOf('@'))}`,
        );
        return {};
      }
      if (tool === 'docker' && args[2] === 'inspect') {
        const reference = args[3] ?? '';
        if (!present.has(reference)) return { status: 1, stderr: `${reference}: not found` };
        const digestOfCopy = reference.slice(reference.indexOf('@') + 1);
        return { stdout: JSON.stringify({ digest: inspectedDigest ?? digestOfCopy }) };
      }
      return {};
    });
    const options: DeployProjectEnvironmentOptions = {
      project: read.project,
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
    return { options, calls, stateDirectory, moduleDirectory, present };
  }

  const isImageCopy = ({ tool, args }: ToolInvocation) => tool === 'docker' && args[2] === 'create';
  const isDocker = ({ tool }: ToolInvocation) => tool === 'docker';

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

  it('copies each image by digest on the first --yes, then stops before Terraform (ADR-0094)', async () => {
    const { options, calls, stateDirectory } = await scenario({ apply: true });

    const { result, output } = await captured(() => deployProjectEnvironment(options));

    expect(result).toMatchObject({ changes: true, applied: false, created: false });
    expect(output).toContain('Images copied. Run --plan to review, then --yes.');
    const copies = calls.filter(isImageCopy);
    expect(copies.map(({ args }) => args)).toEqual(
      (['web', 'gateway', 'runner', 'runtime'] as const).map((name) => [
        'buildx',
        'imagetools',
        'create',
        '--tag',
        `${registry}/${name}:${PLATFORM_IMAGE_VERSION}`,
        release[name],
      ]),
    );
    for (const { args } of copies) expect(args.at(-1)).toMatch(/@sha256:[0-9a-f]{64}$/u);
    // Each destination is inspected once to find it pending, then once to check its copy.
    const destinations = [copied.web, copied.gateway, copied.runner, copied.runtime];
    expect(
      calls
        .filter(({ tool, args }) => tool === 'docker' && args[2] === 'inspect')
        .map(({ args }) => args[3]),
    ).toEqual([...destinations, ...destinations]);
    expect(calls.map(({ args }) => args[1])).not.toContain('plan');
    expect(calls.filter(isApply)).toEqual([]);
    await expect(access(stateDirectory)).rejects.toThrow();
  });

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
    expect(JSON.parse(variables)).toMatchObject({ images: copied });

    const second = stubRunner(({ args }) => (args[1] === 'plan' ? { status: 2 } : {}));
    await captured(() => deployProjectEnvironment({ ...first.options, runner: second.runner }));

    expect(second.calls.filter(isDocker)).toEqual([]);
    expect(second.calls.map(({ args }) => args[1])).not.toContain('output');
    expect(second.calls.map(({ args }) => args[1])).toContain('apply');
    const env = parseEnvironment(await readFile(path.join(first.stateDirectory, '.env'), 'utf8'));
    expect(env['WEB_IMAGE']).toBe(copied.web);
  });

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

  it('refuses a copy whose digest is not the release digest', async () => {
    const { options, calls } = await scenario({ apply: true, inspectedDigest: digest('f') });

    const { message } = await capturedFailure(() => deployProjectEnvironment(options));

    expect(message).toContain("is not the release's digest after the copy");
    expect(calls.filter(isApply)).toEqual([]);
  });

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
});

describe('agent-workspace deploy refusals', () => {
  it('reports a refused profile with its line and calls no tool', async () => {
    const target = await project('gcp');
    const infraDirectory = await infra();
    await writeFile(
      path.join(target, 'agent-workspace.yaml'),
      (await readFile(path.join(target, 'agent-workspace.yaml'), 'utf8')).replace(
        'storage:\n',
        'storage:\n  unknown: x\n',
      ),
    );
    const { runner, calls } = stubRunner(() => ({}));

    const { message } = await capturedFailure(async () =>
      runDeployCommand([target, '--yes', '--infra', infraDirectory], { runner, environment }),
    );

    expect(message).toMatch(/agent-workspace\.yaml line \d+, column 3: storage\.unknown/u);
    expect(calls).toEqual([]);
  });

  it('names agent-workspace doctor when a tool is not installed', async () => {
    const target = await project('gcp');
    const infraDirectory = await infra();
    const runner: ToolRunner = () =>
      Promise.reject(Object.assign(new Error('spawn terraform ENOENT'), { code: 'ENOENT' }));

    const { message } = await capturedFailure(async () =>
      runDeployCommand([target, '--infra', infraDirectory], { runner, environment }),
    );

    expect(message).toContain('terraform is not installed or not on PATH');
    expect(message).toContain('agent-workspace doctor');
  });

  it('refuses a cloud target without --infra, and an uninitialised module, before any tool runs', async () => {
    const target = await project('gcp');
    const { runner, calls } = stubRunner(() => ({}));

    const missing = await capturedFailure(() =>
      runDeployCommand([target], { runner, environment }),
    );
    expect(missing.message).toContain('--infra <dir> is required');

    const bare = await temporaryDirectory();
    await mkdir(path.join(bare, 'terraform', 'gcp-cloudrun'), { recursive: true });
    const uninitialised = await capturedFailure(() =>
      runDeployCommand([target, '--infra', bare], { runner, environment }),
    );
    expect(uninitialised.message).toContain('is not initialised');
    expect(calls).toEqual([]);
  });

  it('fails when the plan itself fails, without applying', async () => {
    const target = await project('gcp');
    const infraDirectory = await infra();
    const { runner, calls } = stubRunner(() => ({ status: 1, stderr: 'Error: backend' }));

    const { message, output } = await capturedFailure(async () =>
      runDeployCommand([target, '--yes', '--infra', infraDirectory], { runner, environment }),
    );

    expect(message).toContain('`terraform plan` failed (exit status 1)');
    expect(output).toContain('Error: backend');
    expect(calls.filter(isApply)).toEqual([]);
  });
});

describe('agent-workspace deploy to Vercel', () => {
  const token = 'vcp_secret_token_value_0123456789';
  const databaseUrl = 'postgres://neondb_owner:np_secret_pw@db.neon.example/aw';
  /** A platform checkout: `apps/web`, at the release the project's images were resolved for. */
  const platform = mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-platform-'));
  mkdirSync(path.join(platform, 'apps', 'web', 'node_modules', 'next'), { recursive: true });
  mkdirSync(path.join(platform, 'packages', 'cli', 'src'), { recursive: true });
  mkdirSync(path.join(platform, 'packages', 'gateway', 'src'), { recursive: true });
  mkdirSync(path.join(platform, 'apps', 'runner', 'src', 'api'), { recursive: true });
  mkdirSync(path.join(platform, 'packages', 'gateway', 'src', 'api'), { recursive: true });
  mkdirSync(path.join(platform, '.git'), { recursive: true });
  mkdirSync(path.join(platform, '.nx', 'cache'), { recursive: true });
  const manifest = (name: string, dependencies: Record<string, string> = {}) =>
    JSON.stringify({ name, dependencies });
  writeFileSync(path.join(platform, 'package.json'), manifest('platform'));
  writeFileSync(path.join(platform, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  writeFileSync(path.join(platform, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(path.join(platform, '.nx', 'cache', 'entry'), 'cached');
  writeFileSync(path.join(platform, 'apps', 'web', 'node_modules', 'next', 'index.js'), '');
  writeFileSync(
    path.join(platform, 'apps', 'web', 'package.json'),
    manifest('@agent-workspace/web', { '@agent-workspace/gateway': 'workspace:*' }),
  );
  writeFileSync(path.join(platform, 'apps', 'runner', 'package.json'), manifest('runner'));
  writeFileSync(
    path.join(platform, 'packages', 'gateway', 'package.json'),
    manifest('@agent-workspace/gateway'),
  );
  writeFileSync(path.join(platform, 'packages', 'gateway', 'src', 'index.ts'), '');
  writeFileSync(path.join(platform, 'packages', 'gateway', 'src', 'api', 'index.ts'), '');
  writeFileSync(path.join(platform, 'apps', 'runner', 'src', 'api', 'index.ts'), '');
  writeFileSync(
    path.join(platform, 'packages', 'cli', 'src', 'release-images.json'),
    JSON.stringify({ version: PLATFORM_IMAGE_VERSION }),
  );
  afterAll(() => {
    rmSync(platform, { recursive: true, force: true });
  });
  const vercelEnvironment = {
    VERCEL_TOKEN: token,
    VERCEL_TEAM_ID: 'team_acme',
    AGENT_WORKSPACE_SOURCE: platform,
  };

  const runtimeImageKey = 'AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK';

  /** Set one `.env` line of a project, replacing the line it already has. */
  async function setEnv(target: string, name: string, value: string): Promise<void> {
    const file = path.join(target, '.env');
    const lines = (await readFile(file, 'utf8'))
      .split('\n')
      .filter((line) => !line.startsWith(`${name}=`));
    await writeFile(file, `${lines.join('\n').replace(/\n*$/u, '\n')}${name}=${value}\n`);
  }

  const vcrImage = `acme/acme-ai-manager/agent-workspace-runtime@sha256:${'a'.repeat(64)}`;

  /** A Vercel project whose `.env` carries the `DATABASE_URL` a Neon integration would set remotely. */
  async function vercelProject(databaseValue = databaseUrl): Promise<string> {
    const target = await project('vercel');
    const file = path.join(target, '.env');
    const text = await readFile(file, 'utf8');
    expect(text).toContain('\nDATABASE_URL=\n');
    await writeFile(
      file,
      `${text
        .replace('\nDATABASE_URL=\n', `\nDATABASE_URL=${databaseValue}\n`)
        .replace(/^OBJECT_STORAGE_ACCESS_KEY_ID=.*$/mu, 'OBJECT_STORAGE_ACCESS_KEY_ID=object-key')
        .replace(
          /^OBJECT_STORAGE_SECRET_ACCESS_KEY=.*$/mu,
          'OBJECT_STORAGE_SECRET_ACCESS_KEY=object-secret',
        )}VERCEL_SANDBOX_RUNTIME_IMAGE=${vcrImage}\n`,
    );
    return target;
  }

  /** `project inspect` and `env ls` answers: the project is absent, or present with `listed` names. */
  const vercelResponder =
    (exists: boolean, listed: readonly string[] = [], echo = ''): Respond =>
    ({ args }) => {
      if (args[1] === 'inspect') {
        return exists
          ? { stdout: `Name acme-ai ${echo}` }
          : { status: 1, stderr: `Error: Project not found ${echo}` };
      }
      if (args[0] === 'env' && args[1] === 'ls') {
        return { stdout: listed.map((name) => `${name}  Encrypted  Production\n`).join('') };
      }
      return { stdout: echo, stderr: echo };
    };

  const changesOf = (calls: readonly ToolInvocation[]) =>
    calls.filter(({ args }) => args[1] === 'add');

  it.each([
    ['VERCEL_TOKEN', { VERCEL_TEAM_ID: 'team_acme' }],
    ['VERCEL_TOKEN', { VERCEL_TOKEN: '  ', VERCEL_TEAM_ID: 'team_acme' }],
    ['VERCEL_TEAM_ID', { VERCEL_TOKEN: token }],
  ])('refuses a missing %s by name and runs no tool', async (name, missing) => {
    const target = await project('vercel');
    const { runner, calls } = stubRunner(() => ({}));

    const { message, output } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: missing }),
    );

    expect(message).toContain(`${name} is not set`);
    expect(message).toContain('Nothing was run');
    expect(`${message}${output}`).not.toContain(token);
    expect(calls).toEqual([]);
  });

  it('plans offline without the token or team id, running no tool (BH061-027)', async () => {
    const target = await project('vercel');
    const { runner, calls } = stubRunner(() => ({}));

    const { result, output } = await captured(() =>
      runDeployCommand([target], { runner, environment: {} }),
    );

    expect(result).toEqual({ changes: true, applied: false });
    expect(calls).toEqual([]);
    expect(output).toContain(`Planning ${target}`);
    expect(output).not.toContain('Deploying');
    expect(output).toContain('VERCEL_TOKEN and VERCEL_TEAM_ID are not set');
    expect(output).toMatch(/Vercel project acme-ai-gateway \(gateway\): \d+ production variable/u);
    expect(output).toContain('Vercel project acme-ai (control plane)');
  });

  it('lists the missing variables and changes nothing without --yes', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(vercelResponder(true, ['SESSION_SECRET']));

    const { result, output } = await captured(() =>
      runDeployCommand([target], { runner, environment: vercelEnvironment }),
    );

    expect(result).toEqual({ changes: true, applied: false });
    expect(output).toContain('MASTER_ENCRYPTION_KEY');
    expect(output).toContain('CRON_SECRET');
    expect(output).not.toContain('SESSION_SECRET,');
    expect(output).toContain('Re-run with --yes');
    expect(changesOf(calls)).toEqual([]);
    // An inspect and a listing for each of the gateway, the manager and the control plane.
    expect(calls.map(({ args }) => `${args[0] ?? ''} ${args[1] ?? ''}`)).toEqual([
      'project inspect',
      'env ls',
      'project inspect',
      'env ls',
      'project inspect',
      'env ls',
    ]);
    expect(calls.map(({ env }) => env['VERCEL_PROJECT_ID'])).toEqual([
      undefined,
      'acme-ai-gateway',
      undefined,
      'acme-ai-manager',
      undefined,
      'acme-ai',
    ]);
  });

  it('needs neither the platform checkout nor DATABASE_URL to plan', async () => {
    const target = await project('vercel');
    const { runner } = stubRunner(vercelResponder(true));

    const { result } = await captured(() =>
      runDeployCommand([target], {
        runner,
        environment: { VERCEL_TOKEN: token, VERCEL_TEAM_ID: 'team_acme' },
      }),
    );

    expect(result).toEqual({ changes: true, applied: false });
  });

  it('creates the project and adds each variable with its value on stdin only', async () => {
    const target = await vercelProject();
    const env = parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'));
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { result } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(result).toEqual({ changes: true, applied: true });
    const created = calls.filter(({ args }) => args[0] === 'project' && args[1] === 'add');
    expect(created.map(({ args }) => args)).toEqual([
      ['project', 'add', 'acme-ai-gateway', '--scope', 'team_acme'],
      ['project', 'add', 'acme-ai-manager', '--scope', 'team_acme'],
      ['project', 'add', 'acme-ai', '--scope', 'team_acme'],
    ]);

    const added = changesOf(calls);
    const master = added.find(({ args }) => args[2] === 'MASTER_ENCRYPTION_KEY');
    expect(master?.args).toEqual([
      'env',
      'add',
      'MASTER_ENCRYPTION_KEY',
      'production',
      '--sensitive',
      '--yes',
      '--scope',
      'team_acme',
    ]);
    expect(master?.input).toBe(env['MASTER_ENCRYPTION_KEY']);
    expect(added.find(({ args }) => args[2] === 'CRON_SECRET')?.args).toContain('--sensitive');
    expect(added.find(({ args }) => args[2] === 'CRON_SECRET')?.input).toBe(env['CRON_SECRET']);
    for (const call of calls) {
      for (const secret of await secretsOf(target))
        expect(call.args.join(' ')).not.toContain(secret);
      expect(call.args.join(' ')).not.toContain(token);
    }
    expect(added.map(({ args }) => args[2])).not.toContain('COMPOSE_PROJECT_NAME');
  });

  it.each([
    ['maps the object storage key pair to AWS_*', '', 'object-key', 'object-secret'],
    [
      'lets an explicit AWS_* win',
      'AWS_ACCESS_KEY_ID=aws-key\nAWS_SECRET_ACCESS_KEY=aws-secret\n',
      'aws-key',
      'aws-secret',
    ],
  ])('%s, the secret as encrypted env that is never printed', async (_, explicit, id, secret) => {
    const target = await vercelProject();
    const file = path.join(target, '.env');
    const text = (await readFile(file, 'utf8'))
      .replace(/^OBJECT_STORAGE_ACCESS_KEY_ID=.*$/mu, 'OBJECT_STORAGE_ACCESS_KEY_ID=object-key')
      .replace(
        /^OBJECT_STORAGE_SECRET_ACCESS_KEY=.*$/mu,
        'OBJECT_STORAGE_SECRET_ACCESS_KEY=object-secret',
      );
    await writeFile(file, `${text}${explicit}`);
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const added = (project: string, name: string) =>
      changesOf(calls).find(
        ({ args, env }) => args[2] === name && env['VERCEL_PROJECT_ID'] === project,
      );
    expect(added('acme-ai', 'AWS_ACCESS_KEY_ID')?.input).toBe(id);
    expect(added('acme-ai', 'AWS_SECRET_ACCESS_KEY')?.input).toBe(secret);
    expect(added('acme-ai', 'AWS_SECRET_ACCESS_KEY')?.args).toContain('--sensitive');
    expect(added('acme-ai-gateway', 'AWS_ACCESS_KEY_ID')).toBeUndefined();
    expect(added('acme-ai-manager', 'AWS_SECRET_ACCESS_KEY')).toBeUndefined();
    for (const call of calls) expect(call.args.join(' ')).not.toMatch(/object-|aws-/u);
    expect(output).not.toMatch(/object-secret|aws-secret/u);
  });

  it('adds only the missing variables, and names the ones it leaves as they are', async () => {
    const target = await vercelProject();
    const env = parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'));
    const { runner, calls } = stubRunner(vercelResponder(true, ['SESSION_SECRET', 'CRON_SECRET']));

    const { result, output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(result).toEqual({ changes: true, applied: true });
    const added = changesOf(calls).map(({ args }) => args[2]);
    expect(added).not.toContain('SESSION_SECRET');
    expect(added).not.toContain('CRON_SECRET');
    expect(added).toContain('MASTER_ENCRYPTION_KEY');
    expect(output).toContain(
      'Left as they are in acme-ai (their values are not compared): SESSION_SECRET, CRON_SECRET.',
    );
    expect(output).toContain('vercel env rm <NAME> production');
    expect(output).not.toContain(env['SESSION_SECRET'] ?? 'unset');
    expect(output).not.toContain(env['CRON_SECRET'] ?? 'unset');
  });

  it('says nothing about left-as-is variables when the project has none of them', async () => {
    const target = await vercelProject();
    const { runner } = stubRunner(vercelResponder(false));

    const { output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(output).not.toContain('Left as they are');
  });

  it('configures every project, migrates once, then deploys the gateway, the manager and the control plane', async () => {
    const target = await vercelProject();
    const env = parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'));
    const uploads: string[][] = [];
    const { runner, calls } = stubRunner((invocation) => {
      if (invocation.args[0] === 'deploy') {
        uploads.push(readdirSync(String(invocation.args[2]), { recursive: true }).map(String));
      }
      return vercelResponder(false)(invocation);
    });

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const steps = calls.map(({ tool, args }) => `${tool} ${args[0] ?? ''} ${args[1] ?? ''}`.trim());
    const dockerAt = steps.findIndex((step) => step.startsWith('docker'));
    const deploys = calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.tool === 'vercel' && call.args[0] === 'deploy');
    expect(steps.slice(0, 3)).toEqual([
      'vercel project inspect',
      'vercel project inspect',
      'vercel project inspect',
    ]);
    expect(steps.filter((step) => step.startsWith('docker'))).toHaveLength(1);
    expect(dockerAt).toBeGreaterThan(steps.lastIndexOf('vercel env add MASTER_ENCRYPTION_KEY'));
    expect(dockerAt).toBeGreaterThan(steps.lastIndexOf('vercel project add'));
    expect(deploys.map(({ call }) => call.env['VERCEL_PROJECT_ID'])).toEqual([
      'acme-ai-gateway',
      'acme-ai-manager',
      'acme-ai',
    ]);
    expect(deploys.every(({ index }) => index > dockerAt)).toBe(true);
    expect(deploys.at(-1)?.index).toBe(calls.length - 1);

    const migrate = calls[dockerAt];
    expect(migrate?.args).toEqual([
      'run',
      '--rm',
      '-e',
      'DATABASE_URL',
      '-e',
      'BOOTSTRAP_ADMIN',
      '-e',
      'WORKSPACE_SLUG',
      '-e',
      'WORKSPACE_NAME',
      env['WEB_IMAGE'] ?? 'unset',
      'sh',
      '-c',
      'node /srv/packages/core/dist/db/migrate.js && node /srv/packages/core/dist/db/seed.js',
    ]);
    expect(migrate?.env['DATABASE_URL']).toBe(databaseUrl);
    expect(migrate?.env['BOOTSTRAP_ADMIN']).toBe(env['BOOTSTRAP_ADMIN']);

    for (const [index, name] of [
      [0, 'gateway'],
      [1, 'manager'],
      [2, 'vercel'],
    ] as const) {
      const staged = String(deploys[index]?.call.args[2]);
      expect(staged).not.toBe(platform);
      expect(deploys[index]?.call.args).toEqual([
        'deploy',
        '--cwd',
        staged,
        '--archive=tgz',
        '--prod',
        '--yes',
        '--scope',
        'team_acme',
        '--local-config',
        path.join(target, 'deploy', 'vercel', `${name}.json`),
      ]);
      expect(deploys[index]?.call.env['VERCEL_TOKEN']).toBe(token);
      await expect(access(staged)).rejects.toThrow();
    }

    // Each upload holds the package its part builds and none of the checkout's dependencies, VCS
    // data or caches; a part does not carry the packages it does not build.
    const [gateway = [], manager = [], controlPlane = []] = uploads;
    for (const upload of uploads) {
      expect(
        upload.filter((entry) => /(^|[\\/])(node_modules|\.git|\.nx)([\\/]|$)/u.test(entry)),
      ).toEqual([]);
    }
    expect(gateway).toContain(path.join('packages', 'gateway', 'src', 'index.ts'));
    expect(manager).not.toContain(path.join('packages', 'gateway', 'src', 'index.ts'));
    expect(controlPlane).toContain(path.join('packages', 'gateway', 'src', 'index.ts'));
    expect(controlPlane).toContain(path.join('apps', 'web', 'package.json'));

    // The gateway and the manager find their function at the upload root, where `functions` points.
    expect(gateway).toContain(path.join('api', 'index.js'));
    expect(manager).toContain(path.join('api', 'index.js'));
    expect(controlPlane).not.toContain(path.join('api', 'index.js'));
  });

  it('sets the Root Directory of each platform project before it deploys, and not the frontend', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(vercelResponder(false));

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const patches = calls.filter(({ args }) => args[0] === 'api');
    expect(patches.map(({ env }) => env['VERCEL_PROJECT_ID'])).toEqual([
      'acme-ai-gateway',
      'acme-ai-manager',
      'acme-ai',
    ]);
    expect(patches.map(({ input }) => JSON.parse(input ?? 'null') as unknown)).toEqual([
      { rootDirectory: null },
      { rootDirectory: null },
      { rootDirectory: 'apps/web', sourceFilesOutsideRootDirectory: true },
    ]);
    for (const patch of patches) {
      expect(patch.tool).toBe('vercel');
      expect(patch.args[1]).toBe(
        `/v9/projects/${patch.env['VERCEL_PROJECT_ID'] ?? ''}?teamId=team_acme`,
      );
      expect(patch.args.slice(2)).toEqual(['-X', 'PATCH', '--input', '-', '--scope', 'team_acme']);
      expect(patch.args.join(' ')).not.toContain(token);
    }
    // Each project's Root Directory is set before any of its variables is written.
    for (const patch of patches) {
      const firstEnvAdd = calls.findIndex(
        ({ args, env }) =>
          args[0] === 'env' &&
          args[1] === 'add' &&
          env['VERCEL_PROJECT_ID'] === patch.env['VERCEL_PROJECT_ID'],
      );
      expect(firstEnvAdd).toBeGreaterThan(calls.indexOf(patch));
    }
    const lastPatch = calls.map(({ args }) => args[0]).lastIndexOf('api');
    expect(lastPatch).toBeLessThan(calls.findIndex(({ args }) => args[0] === 'deploy'));
  });

  it('runs no Root Directory request for a plan', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(vercelResponder(true));

    const { output } = await captured(() =>
      runDeployCommand([target], { runner, environment: vercelEnvironment }),
    );

    expect(calls.some(({ args }) => args[0] === 'api')).toBe(false);
    expect(output).toContain('Root Directory of acme-ai will be set to apps/web.');
  });

  it('refuses a platform checkout without the gateway function entry, before any tool runs', async () => {
    const target = await vercelProject();
    const source = mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-platform-copy-'));
    await cp(platform, source, { recursive: true });
    await rm(path.join(source, 'packages', 'gateway', 'src', 'api'), { recursive: true });
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: { ...vercelEnvironment, AGENT_WORKSPACE_SOURCE: source },
      }),
    );
    await rm(source, { recursive: true, force: true });

    expect(message).toContain(path.join('packages', 'gateway', 'src', 'api', 'index.ts'));
    expect(message).toContain('Nothing was run');
    expect(calls).toEqual([]);
  });

  /** Each project's variables, by what `vercel env add` was given on stdin. */
  const variablesByProject = (calls: readonly ToolInvocation[]) => {
    const byProject = new Map<string, Map<string, string>>();
    for (const call of calls.filter(({ args }) => args[0] === 'env' && args[1] === 'add')) {
      const project = call.env['VERCEL_PROJECT_ID'] ?? '';
      const variables = byProject.get(project) ?? new Map<string, string>();
      variables.set(call.args[2] ?? '', call.input ?? '');
      byProject.set(project, variables);
    }
    return byProject;
  };

  it('gives each project only the variables it needs, and the master key to the gateway and the control plane alone', async () => {
    const target = await vercelProject();
    const env = parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'));
    const { runner, calls } = stubRunner(vercelResponder(false));

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const byProject = variablesByProject(calls);
    const names = (project: string) => [...(byProject.get(project)?.keys() ?? [])].sort();
    expect(names('acme-ai-gateway')).toEqual(
      [
        'DATABASE_URL',
        'GATEWAY_PRICING_JSON',
        'GATEWAY_TOKEN_SECRET',
        'MASTER_ENCRYPTION_KEY',
        'MASTER_KEY_PROVIDER',
      ].sort(),
    );
    expect(names('acme-ai-manager')).toEqual(
      [
        'AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK',
        'AW_VERCEL_TEAM_ID',
        'GATEWAY_PUBLIC_URL',
        'RUNNER_MANAGER_STATELESS',
        'RUNNER_MANAGER_TOKEN',
        'RUNTIME_DRIVER',
      ].sort(),
    );
    const manager = byProject.get('acme-ai-manager');
    expect(manager?.get('RUNNER_MANAGER_STATELESS')).toBe('true');
    expect(manager?.get('GATEWAY_PUBLIC_URL')).toBe('https://acme-ai-gateway.vercel.app');
    expect(manager?.get('AW_VERCEL_TEAM_ID')).toBe('team_acme');
    expect(manager?.get('RUNNER_MANAGER_TOKEN')).toBe(env['RUNNER_MANAGER_TOKEN']);
    const controlPlane = byProject.get('acme-ai');
    expect(controlPlane?.get('MODEL_GATEWAY_URL')).toBe('https://acme-ai-gateway.vercel.app');
    expect(controlPlane?.get('RUNNER_MANAGER_URL')).toBe('https://acme-ai-manager.vercel.app');
    expect(controlPlane?.has('MASTER_ENCRYPTION_KEY')).toBe(true);
    // The engine catalogue: without it no engine is installed and setup's runtime test sends none.
    expect(controlPlane?.has('AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK')).toBe(true);
    for (const name of ['WEB_IMAGE', 'GATEWAY_IMAGE', 'RUNNER_IMAGE', 'E2B_RUNTIME_TEMPLATE']) {
      expect(controlPlane?.has(name), name).toBe(false);
    }
    for (const name of ['MASTER_ENCRYPTION_KEY', 'SESSION_SECRET', 'DATABASE_URL']) {
      expect(manager?.has(name), name).toBe(false);
    }
    expect(byProject.get('acme-ai-gateway')?.has('SESSION_SECRET')).toBe(false);
    for (const variables of byProject.values()) {
      for (const name of variables.keys()) expect(name).not.toMatch(/E2B_API_KEY|VERCEL_TOKEN/u);
    }
  });

  it('gives the AW_PUBLIC_URL that aw deploy writes to the control plane alone (#955)', async () => {
    const target = await vercelProject();
    await setEnv(target, 'AW_PUBLIC_URL', 'https://agents.acme.example');
    const { runner, calls } = stubRunner(vercelResponder(false));

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const added = calls.filter(
      ({ args }) => args[0] === 'env' && args[1] === 'add' && args[2] === 'AW_PUBLIC_URL',
    );
    expect(added.map(({ args, env, input }) => [args[3], env['VERCEL_PROJECT_ID'], input])).toEqual(
      [['production', 'acme-ai', 'https://agents.acme.example']],
    );
  });

  it('gives the vercel-sandbox control plane the deployment policy as JSON, not as the quoted .env line', async () => {
    const target = await vercelProject();
    const policy = '{"promotion":{"minEvalScore":1}}';
    const file = path.join(target, '.env');
    // What `aw deploy` writes: single-quoted, for Compose.
    await writeFile(file, `${await readFile(file, 'utf8')}AW_DEPLOYMENT_POLICY='${policy}'\n`);
    const { runner, calls } = stubRunner(vercelResponder(false));

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const byProject = variablesByProject(calls);
    const controlPlane = byProject.get('acme-ai');
    // apps/web parses this at start-up and refuses to start on a value that is not JSON.
    expect(controlPlane?.get('AW_DEPLOYMENT_POLICY')).toBe(policy);
    expect(controlPlane?.get('RUNTIME_DRIVER')).toBe('vercel-sandbox');
    expect(controlPlane?.has('AW_VERCEL_TEAM_ID')).toBe(false);
    expect(byProject.get('acme-ai-manager')?.has('AW_DEPLOYMENT_POLICY')).toBe(false);
    expect(byProject.get('acme-ai-manager')?.get('AW_VERCEL_TEAM_ID')).toBe('team_acme');
  });

  it('runs the vercel-sandbox manager on its Container Registry image and keeps the control plane on the catalogue image', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(vercelResponder(false));

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const byProject = variablesByProject(calls);
    const manager = byProject.get('acme-ai-manager');
    const controlPlane = byProject.get('acme-ai');
    expect(manager?.get(runtimeImageKey)).toBe(vcrImage);
    expect(controlPlane?.get(runtimeImageKey)).not.toBe(vcrImage);
    expect(controlPlane?.has(runtimeImageKey)).toBe(true);
    for (const variables of byProject.values()) {
      expect(variables.has('VERCEL_SANDBOX_RUNTIME_IMAGE')).toBe(false);
    }
  });

  it.each([
    ['is not set', ''],
    ['is an image from another registry', `ghcr.io/acme/runtime@sha256:${'a'.repeat(64)}`],
    ['names another project', `acme/other-manager/runtime@sha256:${'a'.repeat(64)}`],
    ['is not pinned by digest', 'acme/acme-ai-manager/runtime:latest'],
  ])(
    'refuses a vercel-sandbox deploy whose registry image %s, before any tool runs',
    async (_name, value) => {
      const target = await vercelProject();
      await setEnv(target, 'VERCEL_SANDBOX_RUNTIME_IMAGE', value);
      const { runner, calls } = stubRunner(vercelResponder(false));

      const { message } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
      );

      expect(message).toContain(
        'VERCEL_SANDBOX_RUNTIME_IMAGE must be <team-slug>/acme-ai-manager/',
      );
      expect(message).toContain('Nothing was run');
      if (value !== '') expect(message).not.toContain(value);
      expect(calls).toEqual([]);
    },
  );

  it('gives the Vercel control plane a writable runtime verification file, and keeps one .env sets', async () => {
    for (const driver of ['vercel-sandbox', 'external'] as const) {
      const target = await vercelProject();
      if (driver === 'external') {
        const profile = path.join(target, 'agent-workspace.yaml');
        const text = await readFile(profile, 'utf8');
        await writeFile(profile, text.replace('default: vercel-sandbox', 'default: external'));
        await setEnv(
          target,
          'E2B_RUNTIME_TEMPLATE',
          'acme-runtime:123e4567-e89b-42d3-a456-426614174000',
        );
      }
      const { runner, calls } = stubRunner(vercelResponder(false));

      await captured(() =>
        runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
      );

      const byProject = variablesByProject(calls);
      expect(byProject.get('acme-ai')?.get('RUNTIME_DRIVER'), driver).toBe(driver);
      expect(byProject.get('acme-ai')?.get('AW_RUNTIME_VERIFICATION_FILE'), driver).toBe(
        '/tmp/agent-workspace/runtime-verifications.json',
      );
      for (const project of ['acme-ai-manager', 'acme-ai-gateway']) {
        expect(byProject.get(project)?.has('AW_RUNTIME_VERIFICATION_FILE'), project).toBe(false);
      }
    }

    const target = await vercelProject();
    await setEnv(target, 'AW_RUNTIME_VERIFICATION_FILE', '/tmp/custom/verifications.json');
    const { runner, calls } = stubRunner(vercelResponder(false));
    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );
    expect(variablesByProject(calls).get('acme-ai')?.get('AW_RUNTIME_VERIFICATION_FILE')).toBe(
      '/tmp/custom/verifications.json',
    );
  });

  it('deploys the runtime the profile selects, not the driver .env was created with', async () => {
    const target = await vercelProject();
    const profile = path.join(target, 'agent-workspace.yaml');
    const text = await readFile(profile, 'utf8');
    expect(text).toContain('default: vercel-sandbox');
    await writeFile(profile, text.replace('default: vercel-sandbox', 'default: external'));
    const refused = stubRunner(vercelResponder(false));

    // The runtime image `.env` holds is an OCI digest; the production manager exits 1 on it.
    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner: refused.runner,
        environment: vercelEnvironment,
      }),
    );
    expect(message).toContain('E2B_RUNTIME_TEMPLATE must be an E2B');
    expect(refused.calls).toEqual([]);

    const envFile = path.join(target, '.env');
    await writeFile(
      envFile,
      `${await readFile(envFile, 'utf8')}E2B_RUNTIME_TEMPLATE=acme-runtime:123e4567-e89b-42d3-a456-426614174000\n`,
    );
    const { runner, calls } = stubRunner(vercelResponder(false));

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const manager = variablesByProject(calls).get('acme-ai-manager');
    expect(manager?.get('RUNTIME_DRIVER')).toBe('external');
    expect(manager?.get('EXTERNAL_PROVIDER')).toBe('e2b');
    expect(manager?.get('AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK')).toBe(
      'acme-runtime:123e4567-e89b-42d3-a456-426614174000',
    );
    expect(manager?.has('E2B_RUNTIME_TEMPLATE')).toBe(false);
    expect(manager?.has('AW_VERCEL_TEAM_ID')).toBe(false);
  });

  it('renders the tool-host flag to the manager and control plane for an external runtime only (#827)', async () => {
    const target = await vercelProject();
    const envFile = path.join(target, '.env');
    await writeFile(
      envFile,
      `${await readFile(envFile, 'utf8')}E2B_TOOL_HOST_TEMPLATE=${toolHostTemplate}\n`,
    );
    const sandbox = stubRunner(vercelResponder(false));
    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner: sandbox.runner,
        environment: vercelEnvironment,
      }),
    );
    for (const project of ['acme-ai-manager', 'acme-ai']) {
      const variables = variablesByProject(sandbox.calls).get(project);
      expect(variables?.has('AGENT_WORKSPACE_TOOL_HOST_IMAGE'), project).toBe(false);
      expect(variables?.has('E2B_TOOL_HOST_TEMPLATE'), project).toBe(false);
    }
    // Without a tool host the gateway has no use for the manager token (ADR-0132).
    expect(
      variablesByProject(sandbox.calls).get('acme-ai-gateway')?.has('RUNNER_MANAGER_TOKEN'),
    ).toBe(false);

    const profile = path.join(target, 'agent-workspace.yaml');
    await writeFile(
      profile,
      (await readFile(profile, 'utf8')).replace('default: vercel-sandbox', 'default: external'),
    );
    await writeFile(
      envFile,
      `${await readFile(envFile, 'utf8')}E2B_RUNTIME_TEMPLATE=acme-runtime:123e4567-e89b-42d3-a456-426614174000\n`,
    );
    const external = stubRunner(vercelResponder(false));
    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner: external.runner,
        environment: vercelEnvironment,
      }),
    );
    for (const project of ['acme-ai-manager', 'acme-ai']) {
      const variables = variablesByProject(external.calls).get(project);
      expect(variables?.get('AGENT_WORKSPACE_TOOL_HOST_IMAGE'), project).toBe(toolHostTemplate);
      expect(variables?.has('E2B_TOOL_HOST_TEMPLATE'), project).toBe(false);
    }
    // The manager's tool sandbox route requires the manager token, so the gateway holds it.
    const byProject = variablesByProject(external.calls);
    expect(byProject.get('acme-ai-gateway')?.get('RUNNER_MANAGER_TOKEN')).toBe(
      byProject.get('acme-ai-manager')?.get('RUNNER_MANAGER_TOKEN'),
    );
    expect(byProject.get('acme-ai-gateway')?.has('AGENT_WORKSPACE_TOOL_HOST_IMAGE')).toBe(false);
  });

  it('uses the addresses in .env over the production URLs of the projects', async () => {
    const target = await vercelProject();
    const file = path.join(target, '.env');
    const text = await readFile(file, 'utf8');
    await writeFile(
      file,
      text
        .replace('\nMODEL_GATEWAY_URL=\n', '\nMODEL_GATEWAY_URL=https://gateway.acme.example/\n')
        .replace('\nRUNNER_MANAGER_URL=\n', '\nRUNNER_MANAGER_URL=https://manager.acme.example\n'),
    );
    const { runner, calls } = stubRunner(vercelResponder(false));

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const byProject = variablesByProject(calls);
    expect(byProject.get('acme-ai')?.get('MODEL_GATEWAY_URL')).toBe('https://gateway.acme.example');
    expect(byProject.get('acme-ai')?.get('RUNNER_MANAGER_URL')).toBe(
      'https://manager.acme.example',
    );
    expect(byProject.get('acme-ai-manager')?.get('GATEWAY_PUBLIC_URL')).toBe(
      'https://gateway.acme.example',
    );
  });

  it('refuses an address in .env that is not an https origin, by name, before any tool runs', async () => {
    const target = await vercelProject();
    const file = path.join(target, '.env');
    const text = await readFile(file, 'utf8');
    await writeFile(
      file,
      text.replace('\nMODEL_GATEWAY_URL=\n', '\nMODEL_GATEWAY_URL=http://gw.example/x\n'),
    );
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(message).toContain('MODEL_GATEWAY_URL is http://gw.example/x');
    expect(message).toContain('Nothing was run');
    expect(calls).toEqual([]);
  });

  describe('with a frontend', () => {
    const controlPlaneUrl = 'https://agents.acme.example/';
    async function frontend(): Promise<string> {
      const directory = path.join(await temporaryDirectory(), 'web');
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'package.json'), '{}');
      return directory;
    }

    const deploymentUrl = 'https://acme-ai-web-k3j2h1g-acme.vercel.app';
    const origin = 'https://acme-ai-web.vercel.app';

    /** The frontend's `vercel deploy` prints its deployment URL; `vercel inspect` answers `inspected`. */
    const frontendResponder =
      (listed: readonly string[], inspected: string, deployed = deploymentUrl): Respond =>
      (invocation) => {
        if (invocation.args[0] === 'inspect') return { stdout: inspected };
        if (
          invocation.args[0] === 'deploy' &&
          invocation.env['VERCEL_PROJECT_ID'] === 'acme-ai-web'
        ) {
          return { stdout: `${deployed}\n` };
        }
        return vercelResponder(true, listed)(invocation);
      };
    const inspectedAs = (url: string) =>
      `General\n  ID  dpl_1\n  Name  acme-ai-web\n  URL  ${deploymentUrl}\n\n  Aliases\n    ╶ ${url}\n`;
    const withFrontend = async (respond: Respond) => {
      const target = await vercelProject();
      const web = await frontend();
      const { runner, calls } = stubRunner(respond);
      const { output } = await captured(() =>
        runDeployCommand([target, '--yes'], {
          runner,
          environment: {
            ...vercelEnvironment,
            AGENT_WORKSPACE_FRONTEND: web,
            CONTROL_PLANE_URL: controlPlaneUrl,
          },
        }),
      );
      const originAdds = calls.filter(
        ({ args }) => args[1] === 'add' && args[2] === 'AW_FRONTEND_ORIGIN',
      );
      return { calls, output, originAdds };
    };

    it('lists its own origin in the control plane once Vercel names it for the deployment', async () => {
      const { calls, output, originAdds } = await withFrontend(
        frontendResponder([], inspectedAs(origin)),
      );

      const steps = calls.flatMap(({ args, env }) =>
        args[0] === 'deploy' ||
        args[0] === 'inspect' ||
        (args[1] === 'add' && args[2] === 'AW_FRONTEND_ORIGIN')
          ? [
              `${args[0] === 'env' ? 'add-origin' : String(args[0])}:${env['VERCEL_PROJECT_ID'] ?? ''}`,
            ]
          : [],
      );
      expect(steps).toEqual([
        'deploy:acme-ai-gateway',
        'deploy:acme-ai-manager',
        'deploy:acme-ai-web',
        'inspect:acme-ai-web',
        'add-origin:acme-ai',
        'deploy:acme-ai',
      ]);
      expect(calls.find(({ args }) => args[0] === 'inspect')?.args).toEqual([
        'inspect',
        deploymentUrl,
        '--scope',
        'team_acme',
      ]);
      expect(originAdds).toHaveLength(1);
      expect(originAdds[0]?.args).toEqual([
        'env',
        'add',
        'AW_FRONTEND_ORIGIN',
        'production',
        '--no-sensitive',
        '--yes',
        '--scope',
        'team_acme',
      ]);
      expect(originAdds[0]?.input).toBe(origin);
      expect(calls.some(({ args }) => args.join(' ').includes(origin))).toBe(false);
      expect(output).not.toContain('did not list');
    });

    it('leaves an origin already set as it is on a re-deploy', async () => {
      const { originAdds } = await withFrontend(
        frontendResponder(['AW_FRONTEND_ORIGIN'], inspectedAs(origin)),
      );

      expect(originAdds).toEqual([]);
    });

    it.each([
      ['a domain that is not the project’s', inspectedAs('https://acme-ai-web.example.com')],
      ['a look-alike of the project’s domain', inspectedAs(`${origin}.evil.example`)],
      ['nothing', ''],
    ])(
      'writes no origin when Vercel names %s, and says to list it by hand',
      async (_name, text) => {
        const { calls, output, originAdds } = await withFrontend(frontendResponder([], text));

        expect(originAdds).toEqual([]);
        expect(output).toContain(`Vercel did not list ${origin}`);
        expect(output).toContain(`AW_FRONTEND_ORIGIN=${origin}`);
        expect(calls.filter(({ args }) => args[0] === 'deploy')).toHaveLength(4);
      },
    );

    it('writes no origin when inspect fails', async () => {
      const respond = frontendResponder([], inspectedAs(origin));
      const { originAdds, output } = await withFrontend((invocation) =>
        invocation.args[0] === 'inspect'
          ? { status: 1, stdout: inspectedAs(origin), stderr: 'Error: not found' }
          : respond(invocation),
      );

      expect(originAdds).toEqual([]);
      expect(output).toContain('did not list');
    });

    it.each([
      ['not a URL', 'Deploying acme-ai-web'],
      ['not on vercel.app', 'https://acme-ai-web.example.com'],
      ['carrying credentials', 'https://user:pw@acme-ai-web-k3j2h1g.vercel.app'],
      ['with a path', 'https://acme-ai-web-k3j2h1g.vercel.app/x'],
    ])('does not inspect a deployment URL that is %s', async (_name, deployed) => {
      const { calls, originAdds } = await withFrontend(
        frontendResponder([], inspectedAs(origin), deployed),
      );

      expect(calls.some(({ args }) => args[0] === 'inspect')).toBe(false);
      expect(originAdds).toEqual([]);
    });

    it('deploys it before the control plane, as its own project wired to the control plane', async () => {
      const target = await vercelProject();
      const web = await frontend();
      const { runner, calls } = stubRunner(vercelResponder(false));

      await captured(() =>
        runDeployCommand([target, '--yes'], {
          runner,
          environment: {
            ...vercelEnvironment,
            AGENT_WORKSPACE_FRONTEND: web,
            CONTROL_PLANE_URL: controlPlaneUrl,
          },
        }),
      );

      const added = calls.find(({ args }) => args[1] === 'add' && args[2] === 'VITE_AW_BASE_URL');
      expect(added?.args).toEqual([
        'env',
        'add',
        'VITE_AW_BASE_URL',
        'production',
        '--no-sensitive',
        '--yes',
        '--scope',
        'team_acme',
      ]);
      expect(added?.input).toBe('https://agents.acme.example');
      expect(added?.env['VERCEL_PROJECT_ID']).toBe('acme-ai-web');
      const last = calls.find(
        ({ args, env }) => args[0] === 'deploy' && env['VERCEL_PROJECT_ID'] === 'acme-ai-web',
      );
      expect(calls.at(-1)?.env['VERCEL_PROJECT_ID']).toBe('acme-ai');
      expect(last?.args).toEqual([
        'deploy',
        '--cwd',
        String(last?.args[2]),
        '--archive=tgz',
        '--prod',
        '--yes',
        '--scope',
        'team_acme',
        '--local-config',
        path.join(target, 'deploy', 'vercel', 'frontend.json'),
      ]);
      expect(last?.args[2]).not.toBe(web);
      expect(last?.env['VERCEL_PROJECT_ID']).toBe('acme-ai-web');
      expect(calls.filter(({ args }) => args[0] === 'deploy')).toHaveLength(4);
    });

    it.each([
      ['CONTROL_PLANE_URL', true],
      ['AGENT_WORKSPACE_FRONTEND', false],
    ])('refuses by name when %s is missing or wrong, before any tool runs', async (name, found) => {
      const target = await vercelProject();
      const web = found ? await frontend() : path.join(platform, 'no-such-web');
      const { runner, calls } = stubRunner(vercelResponder(false));

      const { message } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], {
          runner,
          environment: { ...vercelEnvironment, AGENT_WORKSPACE_FRONTEND: web },
        }),
      );

      expect(message).toContain(name);
      expect(message).toContain('Nothing was run');
      expect(calls).toEqual([]);
    });

    it('deploys no frontend when the project has none', async () => {
      const target = await vercelProject();
      const { runner, calls } = stubRunner(vercelResponder(false));

      await captured(() =>
        runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
      );

      expect(calls.some(({ env }) => env['VERCEL_PROJECT_ID'] === 'acme-ai-web')).toBe(false);
      expect(calls.some(({ args }) => args[0] === 'inspect')).toBe(false);
      expect(calls.some(({ args }) => args[2] === 'AW_FRONTEND_ORIGIN')).toBe(false);
    });
  });

  describe('the checkout and the images are one release', () => {
    const writeManifest = async (source: string, version: string) => {
      await mkdir(path.join(source, 'packages', 'cli', 'src'), { recursive: true });
      await writeFile(
        path.join(source, 'packages', 'cli', 'src', 'release-images.json'),
        JSON.stringify({ version }),
      );
    };
    const refused = async (change: (target: string, source: string) => Promise<void>) => {
      const target = await vercelProject();
      const source = await temporaryDirectory();
      await mkdir(path.join(source, 'apps', 'web'), { recursive: true });
      await change(target, source);
      const { runner, calls } = stubRunner(vercelResponder(false));
      const failure = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], {
          runner,
          environment: { ...vercelEnvironment, AGENT_WORKSPACE_SOURCE: source },
        }),
      );
      expect(calls).toEqual([]);
      return failure.message;
    };

    it('refuses a checkout at another release, naming both versions, before any tool runs', async () => {
      const message = await refused((_target, source) => writeManifest(source, '9.9.9'));
      expect(message).toContain('9.9.9');
      expect(message).toContain(PLATFORM_IMAGE_VERSION);
      expect(message).toContain('AGENT_WORKSPACE_VERSION');
      expect(message).toContain('Nothing was run');
    });

    it('refuses a checkout that has no release manifest', async () => {
      const message = await refused(() => Promise.resolve());
      expect(message).toContain('release-images.json');
    });

    it('refuses a .env that does not say which release its images are', async () => {
      const message = await refused(async (target, source) => {
        await writeManifest(source, PLATFORM_IMAGE_VERSION);
        const file = path.join(target, '.env');
        const text = await readFile(file, 'utf8');
        await writeFile(
          file,
          text.replace(/\nAGENT_WORKSPACE_VERSION=[^\n]*\n/u, '\nAGENT_WORKSPACE_VERSION=\n'),
        );
      });
      expect(message).toContain('AGENT_WORKSPACE_VERSION is empty');
    });
  });

  it('keeps the database URL and the token out of every argument and every line of output', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(vercelResponder(false, [], `${databaseUrl} ${token}`));

    const { output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain('np_secret_pw');
      expect(call.args.join(' ')).not.toContain(token);
    }
    expect(output).not.toContain('np_secret_pw');
    expect(output).not.toContain(token);
  });

  it('stops before vercel deploy when the migration fails', async () => {
    const target = await vercelProject();
    const respond = vercelResponder(false);
    const { runner, calls } = stubRunner((invocation) =>
      invocation.tool === 'docker'
        ? { status: 1, stderr: `error: connect ECONNREFUSED ${databaseUrl}` }
        : respond(invocation),
    );

    const { message, output } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(message).toContain('`docker run` failed (exit status 1)');
    expect(`${message}${output}`).not.toContain('np_secret_pw');
    expect(calls.some(({ tool, args }) => tool === 'vercel' && args[0] === 'deploy')).toBe(false);
  });

  it.each([
    'OBJECT_STORAGE_BUCKET',
    'OBJECT_STORAGE_ACCESS_KEY_ID',
    'OBJECT_STORAGE_SECRET_ACCESS_KEY',
  ])('refuses an apply whose .env has no %s, by name, before any tool runs', async (name) => {
    const target = await vercelProject();
    await setEnv(target, name, '');
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { message, output } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(message).toContain(`${name} is empty in .env`);
    expect(message).toContain('Nothing was run');
    expect(`${message}${output}`).not.toContain('object-secret');
    expect(calls).toEqual([]);
  });

  it('gives the control plane the S3-compatible endpoint, bucket and key pair', async () => {
    const target = await vercelProject();
    await setEnv(target, 'OBJECT_STORAGE_ENDPOINT', 'https://acct.r2.cloudflarestorage.com');
    const { runner, calls } = stubRunner(vercelResponder(false));

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const added = changesOf(calls)
      .filter(({ env }) => env['VERCEL_PROJECT_ID'] === 'acme-ai')
      .map(({ args }) => args[2]);
    expect(added).toEqual(
      expect.arrayContaining([
        'OBJECT_STORAGE_BACKEND',
        'OBJECT_STORAGE_ENDPOINT',
        'OBJECT_STORAGE_BUCKET',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
      ]),
    );
  });

  it('does not ask a non-S3 object store for an S3 key pair', async () => {
    const target = await vercelProject();
    await setEnv(target, 'OBJECT_STORAGE_BACKEND', 'gcs');
    await setEnv(target, 'OBJECT_STORAGE_ACCESS_KEY_ID', '');
    await setEnv(target, 'OBJECT_STORAGE_SECRET_ACCESS_KEY', '');
    const { runner } = stubRunner(vercelResponder(false));

    const { result } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(result).toEqual({ changes: true, applied: true });
  });

  it('runs neither the migration nor vercel deploy for a plan', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(vercelResponder(true));

    await captured(() => runDeployCommand([target], { runner, environment: vercelEnvironment }));

    expect(calls.some(({ tool }) => tool === 'docker')).toBe(false);
    expect(calls.some(({ args }) => args[0] === 'deploy')).toBe(false);
  });

  it.each([
    ['AGENT_WORKSPACE_SOURCE', { VERCEL_TOKEN: token, VERCEL_TEAM_ID: 'team_acme' }, true],
    ['DATABASE_URL', vercelEnvironment, false],
  ])('refuses an apply without %s by name, before any tool runs', async (name, env, hasUrl) => {
    const target = hasUrl ? await vercelProject() : await project('vercel');
    await setEnv(target, 'VERCEL_SANDBOX_RUNTIME_IMAGE', vcrImage);
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: env }),
    );

    expect(message).toContain(name);
    expect(message).toContain('Nothing was run');
    expect(calls).toEqual([]);
  });

  it('refuses an AGENT_WORKSPACE_SOURCE that is not a platform checkout, before any tool runs', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: { ...vercelEnvironment, AGENT_WORKSPACE_SOURCE: path.join(platform, 'typo') },
      }),
    );

    expect(message).toContain('AGENT_WORKSPACE_SOURCE');
    expect(message).toContain('no apps/web directory');
    expect(message).toContain('Nothing was run');
    expect(calls).toEqual([]);
  });

  it('refuses a part the checkout cannot stage, before any tool runs', async () => {
    const target = await vercelProject();
    const source = await temporaryDirectory();
    await cp(platform, source, { recursive: true });
    await writeFile(
      path.join(source, 'apps', 'runner', 'package.json'),
      manifest('runner', { '@agent-workspace/missing': 'workspace:*' }),
    );
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: { ...vercelEnvironment, AGENT_WORKSPACE_SOURCE: source },
      }),
    );

    expect(message).toContain('@agent-workspace/missing');
    expect(message).toContain('Nothing was run');
    expect(calls).toEqual([]);
  });

  it('names the Neon integration only when DATABASE_URL is the empty value', async () => {
    const target = await vercelProject();
    const file = path.join(target, '.env');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace(/\nBOOTSTRAP_ADMIN=[^\n]*\n/u, '\nBOOTSTRAP_ADMIN=\n'));
    const { runner } = stubRunner(vercelResponder(false));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(message).toContain('BOOTSTRAP_ADMIN is empty');
    expect(message).not.toContain('Neon');
  });

  it('hands the token to the tool through its environment and never prints it', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(vercelResponder(false, [], token));

    const { output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(calls.every((call) => call.env['VERCEL_TOKEN'] === token)).toBe(true);
    expect(output).not.toContain(token);
  });

  it('creates a project the current Vercel CLI reports as having no project, with --scope only', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(({ args }) =>
      args[1] === 'inspect'
        ? {
            status: 1,
            stderr:
              'WARNING! The "--team" option is deprecated. Please use "--scope" instead.\n' +
              `Error: There is no project for "${args[2] ?? ''}"\n`,
          }
        : {},
    );

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(calls.filter(({ args }) => args[0] === 'project' && args[1] === 'add')).toHaveLength(3);
    const vercelArgs = calls.filter(({ tool }) => tool === 'vercel').flatMap(({ args }) => args);
    expect(vercelArgs).toContain('--scope');
    expect(vercelArgs).not.toContain('--team');
  });

  it('does not take a failed inspect for a missing project, and redacts what it reports', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(() => ({
      status: 1,
      stderr: `Error: The specified token is not valid ${token}`,
    }));

    const { message, output } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(message).toContain('did not say the project is missing');
    expect(`${message}${output}`).not.toContain(token);
    expect(changesOf(calls)).toEqual([]);
    expect(calls.some(({ args }) => args[0] === 'project' && args[1] === 'add')).toBe(false);
  });

  it('refuses --target helm for a Vercel profile and --target vercel for another cloud', async () => {
    const vercel = await project('vercel');
    const gcp = await project('gcp');
    const { runner, calls } = stubRunner(() => ({}));

    const helm = await capturedFailure(() =>
      runDeployCommand([vercel, '--target', 'helm'], { runner, environment: vercelEnvironment }),
    );
    const other = await capturedFailure(() =>
      runDeployCommand([gcp, '--target', 'vercel'], { runner, environment: vercelEnvironment }),
    );

    expect(helm.message).toContain('does not apply to cloud "vercel"');
    expect(other.message).toContain('--target vercel does not apply to cloud "gcp"');
    expect(calls).toEqual([]);
  });

  it('names agent-workspace doctor when the vercel CLI is not installed', async () => {
    const target = await project('vercel');
    const runner: ToolRunner = () =>
      Promise.reject(Object.assign(new Error('spawn vercel ENOENT'), { code: 'ENOENT' }));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target], { runner, environment: vercelEnvironment }),
    );

    expect(message).toContain('vercel is not installed or not on PATH');
    expect(message).toContain('agent-workspace doctor');
  });
});

describe('agent-workspace deploy to Cloudflare', () => {
  const token = 'cfat_secret_token_value_0123456789';
  const cloudflareEnvironment = {
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: 'acct123',
    CLOUDFLARE_WORKERS_SUBDOMAIN: 'acme',
    CONTROL_PLANE_URL: 'https://app.example.com',
  };
  const databaseUrl = 'postgres://neondb_owner:np_secret_pw@db.neon.example/aw';
  // No test of this target reaches a real network: the control plane answers /setup unless it says otherwise.
  beforeEach(() => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const bridgeUrl = 'https://acme-ai-bridge.acme.workers.dev';
  const registry = (repository: string, character: string) =>
    `registry.cloudflare.com/acct123/agent-workspace-${repository}:sha256-${character.repeat(64)}`;

  /**
   * A project an apply can run: the `DATABASE_URL` and sandbox bridge the operator fills, on the
   * native `cloudflare-sandbox` driver the operator chose over the E2B default (BH061-029).
   */
  async function cloudflareProject(): Promise<string> {
    const target = await project('cloudflare');
    await selectNativeSandbox(target);
    const file = path.join(target, '.env');
    const text = await readFile(file, 'utf8');
    expect(text).toContain('\nDATABASE_URL=\n');
    await writeFile(
      file,
      `${text.replace('\nDATABASE_URL=\n', `\nDATABASE_URL=${databaseUrl}\n`)}CLOUDFLARE_SANDBOX_BRIDGE_URL=${bridgeUrl}\n`,
    );
    await editEnv(target, 'OBJECT_STORAGE_ACCESS_KEY_ID', 'r2-access-key');
    await editEnv(target, 'OBJECT_STORAGE_SECRET_ACCESS_KEY', 'r2-secret-key');
    return target;
  }

  const e2bTemplate = 'acme-runtime:123e4567-e89b-42d3-a456-426614174000';
  const runtimeImageKey = 'AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK';

  async function appendEnv(target: string, name: string, value: string): Promise<void> {
    const file = path.join(target, '.env');
    await writeFile(file, `${await readFile(file, 'utf8')}${name}=${value}\n`);
  }

  async function editEnv(target: string, name: string, value: string): Promise<void> {
    const file = path.join(target, '.env');
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replace(new RegExp(`^${name}=.*$`, 'mu'), `${name}=${value}`),
    );
  }

  /** Select `cloudflare-sandbox` in the profile and `.env`, as a project created before BH061-029 has it. */
  async function selectNativeSandbox(target: string): Promise<void> {
    const profile = path.join(target, 'agent-workspace.yaml');
    const yaml = await readFile(profile, 'utf8');
    expect(yaml).toContain('default: external');
    await writeFile(profile, yaml.replace('default: external', 'default: cloudflare-sandbox'));
    const file = path.join(target, '.env');
    const env = await readFile(file, 'utf8');
    const external = '# Runtime: external\nRUNTIME_DRIVER=external\nEXTERNAL_PROVIDER=e2b\n';
    expect(env).toContain(external);
    await writeFile(
      file,
      env.replace(external, '# Runtime: cloudflare-sandbox\nRUNTIME_DRIVER=cloudflare-sandbox\n'),
    );
  }

  /** Select E2B in the profile only, as an operator does: `.env` keeps the driver it was created with. */
  async function selectExternalRuntime(target: string): Promise<void> {
    const file = path.join(target, 'agent-workspace.yaml');
    const text = await readFile(file, 'utf8');
    expect(text).toContain('default: cloudflare-sandbox');
    await writeFile(file, text.replace('default: cloudflare-sandbox', 'default: external'));
  }

  /** A project's `web/`, which the frontend Worker is built from. */
  async function frontend(): Promise<string> {
    const directory = path.join(await temporaryDirectory(), 'web');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), '{}');
    return directory;
  }

  /**
   * The rules of Wrangler 4.147's configuration validation that the Container Workers' files can
   * break (`validateContainerApp` and the Durable Object checks). Wrangler is not a dependency of
   * this repository, so its own reader cannot run here; the live journey runs the real one.
   */
  function wranglerProblems(configuration: Record<string, unknown>): string[] {
    const problems: string[] = [];
    const parsed = z
      .object({
        name: z.string().min(1).optional(),
        main: z.string().min(1),
        containers: z
          .array(
            z.object({
              name: z.string().min(1).optional(),
              class_name: z.string().min(1).optional(),
              image: z.string().min(1),
            }),
          )
          .default([]),
        durable_objects: z
          .object({ bindings: z.array(z.object({ name: z.string(), class_name: z.string() })) })
          .optional(),
        migrations: z
          .array(z.object({ new_sqlite_classes: z.array(z.string()).optional() }))
          .default([]),
      })
      .safeParse(configuration);
    if (!parsed.success) return [parsed.error.message];
    const { name, containers, durable_objects: objects, migrations } = parsed.data;
    for (const container of containers) {
      if (
        container.name === undefined &&
        (name === undefined || container.class_name === undefined)
      ) {
        problems.push('containers need a top level "name" and "class_name", or their own "name"');
      }
      const className = container.class_name ?? '';
      if (!objects?.bindings.some((binding) => binding.class_name === className)) {
        problems.push(`${className} has no Durable Object binding`);
      }
      if (!migrations.some((migration) => migration.new_sqlite_classes?.includes(className))) {
        problems.push(`${className} has no Durable Object migration`);
      }
    }
    return problems;
  }

  /**
   * `secret list` answers: the Worker is absent, or present with `listed` secret names.
   * `containers images list` answers with `registryTags`. The configuration each `wrangler deploy`
   * is handed is read as it runs, because it is a temporary file removed afterwards.
   */
  function cloudflareResponder(
    exists: boolean,
    options: {
      listed?: readonly string[];
      echo?: string;
      registryTags?: string;
      failRun?: boolean;
      /** What `r2 bucket info` answers: the bucket is missing, or the call fails for another reason. */
      bucket?: 'missing' | 'denied';
    } = {},
  ): { respond: Respond; deployed: Map<string, Record<string, unknown>> } {
    const { listed = [], echo = '', registryTags = '', failRun = false, bucket } = options;
    const deployed = new Map<string, Record<string, unknown>>();
    const respond: Respond = ({ tool, args }) => {
      if (args[0] === 'r2' && args[2] === 'info' && bucket !== undefined) {
        return {
          status: 1,
          stderr:
            bucket === 'missing'
              ? 'The specified bucket does not exist. [code: 10006]'
              : 'Authentication error [code: 10000]',
        };
      }
      if (args[0] === 'secret' && args[1] === 'list') {
        return exists
          ? { stdout: JSON.stringify(listed.map((name) => ({ name, type: 'secret_text' }))) }
          : {
              status: 1,
              stderr: `A request to the Cloudflare API failed. Worker not found. ${echo}`,
            };
      }
      if (args[0] === 'containers' && args[1] === 'images') return { stdout: registryTags };
      if (tool === 'docker' && args[0] === 'run' && failRun) {
        return { status: 1, stderr: 'migration failed' };
      }
      // `deploy --config <file> --name <worker>` and `secret bulk --name <worker> --config <file>`.
      const isDeploy = args[0] === 'deploy' && args[1] === '--config';
      const isBulk = args[0] === 'secret' && args[1] === 'bulk';
      const file = isDeploy ? args[2] : isBulk ? args[5] : undefined;
      const worker = (isDeploy ? args[4] : args[3]) ?? '';
      if (file !== undefined) {
        const configuration = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(readFileSync(file, 'utf8')));
        if ('containers' in configuration) {
          expect(configuration['name']).toBe(worker);
          expect(wranglerProblems(configuration)).toEqual([]);
        }
        if (isDeploy) deployed.set(worker, configuration);
        else expect(configuration).toEqual(deployed.get(worker));
      }
      return { stdout: echo, stderr: echo };
    };
    return { respond, deployed };
  }

  const putsOf = (calls: readonly ToolInvocation[]) =>
    calls
      .filter(({ args }) => args[0] === 'secret' && args[1] === 'put')
      .map(({ args, input }) => [args[2], input, args[4]]);
  const retentionPuts = (calls: readonly ToolInvocation[]) =>
    putsOf(calls)
      .filter(([, , name]) => name === 'acme-ai')
      .map(([name, input]) => [name, input]);
  const bulksOf = (calls: readonly ToolInvocation[]) =>
    calls.filter(({ args }) => args[0] === 'secret' && args[1] === 'bulk');
  /** The secrets one Worker received, as the one `wrangler secret bulk` call reads them from stdin. */
  const bulkFor = (calls: readonly ToolInvocation[], worker: string): Record<string, string> =>
    z
      .record(z.string(), z.string())
      .parse(JSON.parse(bulksOf(calls).find(({ args }) => args[3] === worker)?.input ?? 'null'));
  const controlPlanePuts = (calls: readonly ToolInvocation[]) =>
    Object.entries(bulkFor(calls, 'acme-ai-control-plane'));
  const summary = (calls: readonly ToolInvocation[]) =>
    calls.map(({ tool, args }) => `${tool} ${args.slice(0, 2).join(' ')}`);

  it.each([
    ['CLOUDFLARE_API_TOKEN', { CLOUDFLARE_ACCOUNT_ID: 'acct123' }],
    ['CLOUDFLARE_API_TOKEN', { CLOUDFLARE_API_TOKEN: '  ', CLOUDFLARE_ACCOUNT_ID: 'acct123' }],
    ['CLOUDFLARE_ACCOUNT_ID', { CLOUDFLARE_API_TOKEN: token }],
    [
      'CLOUDFLARE_WORKERS_SUBDOMAIN',
      { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: 'acct123' },
    ],
    [
      'CONTROL_PLANE_URL',
      {
        CLOUDFLARE_API_TOKEN: token,
        CLOUDFLARE_ACCOUNT_ID: 'acct123',
        CLOUDFLARE_WORKERS_SUBDOMAIN: 'acme',
      },
    ],
  ])('refuses a missing %s by name and runs no tool', async (name, missing) => {
    const target = await project('cloudflare');
    const { runner, calls } = stubRunner(() => ({}));

    const { message, output } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: missing }),
    );

    expect(message).toContain(`${name} is not set`);
    expect(message).toContain('Nothing was run');
    expect(`${message}${output}`).not.toContain(token);
    expect(calls).toEqual([]);
  });

  it('plans offline without the token or account id, running no tool (BH061-027)', async () => {
    const target = await project('cloudflare');
    const { runner, calls } = stubRunner(() => ({}));

    const { result, output } = await captured(() =>
      runDeployCommand([target], { runner, environment: { CLOUDFLARE_ACCOUNT_ID: 'acct123' } }),
    );

    expect(result).toEqual({ changes: true, applied: false });
    expect(calls).toEqual([]);
    expect(output).toContain(`Planning ${target}`);
    expect(output).not.toContain('Deploying');
    expect(output).toContain('CLOUDFLARE_API_TOKEN is not set, so this plan reads nothing');
    expect(output).toContain('Cloudflare account acct123');
    expect(output).toContain('https://acme-ai-gateway.<CLOUDFLARE_WORKERS_SUBDOMAIN>.workers.dev');
    expect(output).toContain('Image web');
    expect(output).toContain(': will be created;');
  });

  it.each(['acme.workers.dev', 'https://acme', '-acme', 'a b'])(
    'refuses the workers.dev subdomain %j, which is not a DNS label',
    async (subdomain) => {
      const target = await project('cloudflare');
      const { runner, calls } = stubRunner(() => ({}));

      const { message } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], {
          runner,
          environment: { ...cloudflareEnvironment, CLOUDFLARE_WORKERS_SUBDOMAIN: subdomain },
        }),
      );

      expect(message).toContain('CLOUDFLARE_WORKERS_SUBDOMAIN must be');
      expect(calls).toEqual([]);
    },
  );

  it('refuses a control plane URL that is not https', async () => {
    const target = await project('cloudflare');
    const { runner, calls } = stubRunner(() => ({}));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: { ...cloudflareEnvironment, CONTROL_PLANE_URL: 'http://app.example.com' },
      }),
    );

    expect(message).toContain('CONTROL_PLANE_URL must be an https:// URL');
    expect(calls).toEqual([]);
  });

  it('names what it would deploy and put, and changes nothing without --yes', async () => {
    const target = await project('cloudflare');
    const { respond } = cloudflareResponder(true, { listed: ['CRON_SECRET'] });
    const { runner, calls } = stubRunner(respond);

    const { result, output } = await captured(() =>
      runDeployCommand([target], { runner, environment: cloudflareEnvironment }),
    );

    expect(result).toEqual({ changes: true, applied: false });
    expect(output).toContain('CONTROL_PLANE_URL, CRON_SECRET');
    expect(output).toContain('MASTER_ENCRYPTION_KEY');
    expect(output).toContain('OBJECT_STORAGE_ENDPOINT');
    expect(output).not.toContain(await masterKey(target));
    expect(output).toContain('acme-ai-gateway (https://acme-ai-gateway.acme.workers.dev)');
    expect(output).toContain('acme-ai-manager (https://acme-ai-manager.acme.workers.dev)');
    expect(output).toContain('No frontend Worker');
    expect(output).not.toContain('are not deployed');
    // The read-only registry probe runs in a plan too, and says what an apply would push.
    expect(summary(calls)).toEqual(['wrangler secret list', 'wrangler containers images']);
    expect(output).toContain(`Image web (sha256-${'1'.repeat(64)}): push.`);
    expect(putsOf(calls)).toEqual([]);
  });

  it('says in a plan which images the registry already holds', async () => {
    const target = await project('cloudflare');
    const { respond } = cloudflareResponder(true, { registryTags: `sha256-${'2'.repeat(64)}` });
    const { runner, calls } = stubRunner(respond);

    const { output } = await captured(() =>
      runDeployCommand([target], { runner, environment: cloudflareEnvironment }),
    );

    expect(output).toContain(`Image web (sha256-${'1'.repeat(64)}): push.`);
    expect(output).toContain(
      `Image gateway (sha256-${'2'.repeat(64)}): skip, already in the registry.`,
    );
    expect(calls.some(({ tool }) => tool === 'docker')).toBe(false);
  });

  it('refuses a .env without CRON_SECRET by name and runs no tool', async () => {
    const target = await project('cloudflare');
    await editEnv(target, 'CRON_SECRET', '');
    const { runner, calls } = stubRunner(() => ({}));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(message).toContain('CRON_SECRET is not set');
    expect(calls).toEqual([]);
  });

  const masterKey = async (target: string) =>
    parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'))['MASTER_ENCRYPTION_KEY'];

  describe('tolerates Cloudflare not knowing a Worker it just uploaded (error 10007)', () => {
    const propagating =
      '✘ [ERROR] A request to the Cloudflare API (/accounts/acct123/workers/workers/acme-ai-gateway) ' +
      'failed.\n  This Worker does not exist on your account. [code: 10007]';
    const delaysMs = [1, 1, 1];

    /** `wrangler deploy` of the gateway Worker fails with `stderr` for its first `failures` runs. */
    function failingGatewayDeploy(failures: number, stderr: string) {
      const { respond } = cloudflareResponder(false);
      let seen = 0;
      const wrapped: Respond = (invocation) => {
        const { args } = invocation;
        if (args[0] === 'deploy' && args[4] === 'acme-ai-gateway') {
          seen += 1;
          if (seen <= failures) return { status: 1, stderr };
        }
        return respond(invocation);
      };
      return stubRunner(wrapped);
    }
    const gatewayDeploys = (calls: readonly ToolInvocation[]) =>
      calls.filter(({ args }) => args[0] === 'deploy' && args[4] === 'acme-ai-gateway').length;

    it('matches code 10007 only', () => {
      expect(isWorkerPropagating(propagating)).toBe(true);
      expect(isWorkerPropagating('Authentication error [code: 10000]')).toBe(false);
      expect(isWorkerPropagating('The bucket does not exist. [code: 10006]')).toBe(false);
      expect(isWorkerPropagating('Worker 10007 not found')).toBe(false);
    });

    it('runs the deploy again until Cloudflare knows the Worker, then carries on', async () => {
      const target = await cloudflareProject();
      const { runner, calls } = failingGatewayDeploy(2, propagating);

      const { result, output } = await captured(() =>
        runDeployCommand([target, '--yes'], {
          runner,
          environment: cloudflareEnvironment,
          workerRetryDelaysMs: delaysMs,
        }),
      );

      expect(result).toEqual({ changes: true, applied: true });
      expect(gatewayDeploys(calls)).toBe(3);
      expect(output).toContain('[code: 10007]');
      expect(output).toContain('That failure is transient');
      expect(output).toContain('Applied.');
    });

    it('stops after the last delay with the typed failure', async () => {
      const target = await cloudflareProject();
      const { runner, calls } = failingGatewayDeploy(Infinity, propagating);

      const { message } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], {
          runner,
          environment: cloudflareEnvironment,
          workerRetryDelaysMs: delaysMs,
        }),
      );

      expect(gatewayDeploys(calls)).toBe(1 + delaysMs.length);
      expect(message).toBe('`wrangler deploy` failed (exit status 1); its output is above.');
      expect(calls.some(({ args }) => args[0] === 'secret' && args[1] === 'bulk')).toBe(false);
    });

    it('does not retry any other error', async () => {
      const target = await cloudflareProject();
      const { runner, calls } = failingGatewayDeploy(
        Infinity,
        'Authentication error [code: 10000]',
      );

      const { message } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], {
          runner,
          environment: cloudflareEnvironment,
          workerRetryDelaysMs: delaysMs,
        }),
      );

      expect(gatewayDeploys(calls)).toBe(1);
      expect(message).toContain('`wrangler deploy` failed');
    });

    it('reads 10007 from `secret list` as a missing Worker, without retrying it', async () => {
      const target = await cloudflareProject();
      const { respond } = cloudflareResponder(false);
      const { runner, calls } = stubRunner((invocation) => {
        const { args } = invocation;
        if (args[0] === 'secret' && args[1] === 'list') {
          return { status: 1, stderr: 'This Worker does not exist on your account. [code: 10007]' };
        }
        return respond(invocation);
      });

      const { result } = await captured(() =>
        runDeployCommand([target, '--yes'], {
          runner,
          environment: cloudflareEnvironment,
          workerRetryDelaysMs: delaysMs,
        }),
      );

      expect(result).toEqual({ changes: true, applied: true });
      expect(calls.filter(({ args }) => args[0] === 'secret' && args[1] === 'list')).toHaveLength(
        1,
      );
      expect(calls.some(({ args }) => args[0] === 'deploy' && args[4] === 'acme-ai')).toBe(true);
    });

    it('runs `secret bulk` again while Cloudflare does not know the Worker yet', async () => {
      const target = await cloudflareProject();
      const { respond } = cloudflareResponder(false);
      let failed = false;
      const { runner, calls } = stubRunner((invocation) => {
        const { args } = invocation;
        if (
          args[0] === 'secret' &&
          args[1] === 'bulk' &&
          args[3] === 'acme-ai-gateway' &&
          !failed
        ) {
          failed = true;
          return { status: 1, stderr: propagating };
        }
        return respond(invocation);
      });

      const { result } = await captured(() =>
        runDeployCommand([target, '--yes'], {
          runner,
          environment: cloudflareEnvironment,
          workerRetryDelaysMs: delaysMs,
        }),
      );

      expect(result).toEqual({ changes: true, applied: true });
      expect(bulksOf(calls).filter(({ args }) => args[3] === 'acme-ai-gateway')).toHaveLength(2);
    });
  });

  describe('waits for the control plane', () => {
    const readiness = { windowMs: 250, delayMs: 5, requestTimeoutMs: 1_000 };
    const managerHealth = 'https://acme-ai-manager.acme.workers.dev/healthz';
    const hrefOf = (url: string | URL | Request) =>
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;

    it('polls /setup after the last upload, through 503s, then reports Applied', async () => {
      const target = await cloudflareProject();
      const { runner, calls } = stubRunner(cloudflareResponder(false).respond);
      const answers = [503, 503, 200];
      const requests: { url: string; redirect: string | undefined }[] = [];
      const fetchStub = vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const href = hrefOf(url);
        // The runner manager is awaited after the control plane; this case is about /setup.
        if (href === managerHealth) return Promise.resolve(new Response('ok', { status: 200 }));
        requests.push({ url: href, redirect: init?.redirect });
        return Promise.resolve(
          new Response('The control plane is starting', { status: answers.shift() ?? 500 }),
        );
      });

      const { result, output } = await captured(() =>
        runDeployCommand([target, '--yes'], {
          runner,
          environment: cloudflareEnvironment,
          fetch: fetchStub,
          readiness: { ...readiness, windowMs: 5_000 },
        }),
      );

      expect(result).toEqual({ changes: true, applied: true });
      expect(requests).toEqual([
        { url: 'https://app.example.com/setup', redirect: 'manual' },
        { url: 'https://app.example.com/setup', redirect: 'manual' },
        { url: 'https://app.example.com/setup', redirect: 'manual' },
      ]);
      expect(output).toContain('Waiting for the control plane at https://app.example.com/setup');
      expect(output).toContain('Applied.');
      expect(calls.at(-1)?.args.slice(0, 2)).toEqual(['secret', 'put']);
      expect(JSON.stringify(fetchStub.mock.calls)).not.toContain(token);
    });

    it('fails with the status, the Worker body and the Worker name when it never answers 200', async () => {
      const target = await cloudflareProject();
      const { runner, calls } = stubRunner(cloudflareResponder(false).respond);
      const fetchStub = vi.fn(() =>
        Promise.resolve(
          new Response('The control plane did not answer on port 3000 within 60 s', {
            status: 503,
          }),
        ),
      );

      const { message, output } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], {
          runner,
          environment: cloudflareEnvironment,
          fetch: fetchStub,
          readiness,
        }),
      );

      expect(fetchStub.mock.calls.length).toBeGreaterThan(1);
      expect(message).toContain(
        'acme-ai-control-plane did not answer https://app.example.com/setup',
      );
      expect(message).toMatch(/in 0\.25 s \(\d+ requests\); last: HTTP 503/u);
      expect(message).toContain('were applied');
      expect(output).toContain('did not answer on port 3000 within 60 s');
      expect(output).not.toContain('Applied.');
      expect(calls.filter(({ args }) => args[0] === 'deploy')).toHaveLength(4);
      expect(`${message}${output}`).not.toContain(token);
    });

    it("names Cloudflare's error code, page title and ray instead of printing its HTML boilerplate", async () => {
      const target = await cloudflareProject();
      const page =
        '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n' +
        '<html><head><title>Worker threw exception | app.workers.dev | Cloudflare</title></head>' +
        '<body><span class="cf-error-code">1101</span><h1>Error 1101</h1></body></html>';
      const fetchStub = vi.fn(() =>
        Promise.resolve(
          new Response(page, { status: 500, headers: { 'cf-ray': '9a1b2c3d4e5f-NRT' } }),
        ),
      );

      const { message, output } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], {
          runner: stubRunner(cloudflareResponder(false).respond).runner,
          environment: cloudflareEnvironment,
          fetch: fetchStub,
          readiness,
        }),
      );

      expect(message).toContain('last: HTTP 500');
      expect(output).toContain('title: Worker threw exception | app.workers.dev | Cloudflare');
      expect(output).toContain('code: Error 1101');
      expect(output).toContain('cf-ray: 9a1b2c3d4e5f-NRT');
      expect(output).not.toContain('<!DOCTYPE');
    });

    it('keeps the body of an HTML answer that has a cf-ray but no title and no error code', async () => {
      const target = await cloudflareProject();
      const page = '<html><body><h1>The app could not render this page</h1></body></html>';
      const fetchStub = vi.fn(() =>
        Promise.resolve(
          new Response(page, { status: 500, headers: { 'cf-ray': '9a1b2c3d4e5f-NRT' } }),
        ),
      );

      const { output } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], {
          runner: stubRunner(cloudflareResponder(false).respond).runner,
          environment: cloudflareEnvironment,
          fetch: fetchStub,
          readiness: { ...readiness, windowMs: 0 },
        }),
      );

      expect(output).toContain('The app could not render this page');
    });

    it("shows the step in the Worker's own JSON answer", async () => {
      const target = await cloudflareProject();
      const body = { error: { code: 'worker_exception', step: 'forward', message: 'Error: x' } };
      const { output } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], {
          runner: stubRunner(cloudflareResponder(false).respond).runner,
          environment: cloudflareEnvironment,
          fetch: () => Promise.resolve(Response.json(body, { status: 502 })),
          readiness,
        }),
      );

      expect(output).toContain('HTTP 502');
      expect(output).toContain('\\"step\\":\\"forward\\"');
    });

    it('does not count a redirect as an answer, and names a network failure', async () => {
      const target = await cloudflareProject();
      const redirected = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], {
          runner: stubRunner(cloudflareResponder(false).respond).runner,
          environment: cloudflareEnvironment,
          fetch: () =>
            Promise.resolve(new Response(null, { status: 307, headers: { location: '/signin' } })),
          readiness,
        }),
      );
      expect(redirected.message).toContain('last: HTTP 307');

      const unreachable = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], {
          runner: stubRunner(cloudflareResponder(true).respond).runner,
          environment: cloudflareEnvironment,
          fetch: () =>
            Promise.reject(
              new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND app') }),
            ),
          readiness,
        }),
      );
      expect(unreachable.message).toContain('last: network error (TypeError)');
      expect(unreachable.output).toContain('getaddrinfo ENOTFOUND app');
    });

    it('makes one request when the window is already spent', async () => {
      const target = await cloudflareProject();
      const fetchStub = vi.fn(() => Promise.resolve(new Response('starting', { status: 503 })));

      const { message } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], {
          runner: stubRunner(cloudflareResponder(false).respond).runner,
          environment: cloudflareEnvironment,
          fetch: fetchStub,
          readiness: { ...readiness, windowMs: 0 },
        }),
      );

      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(message).toContain('(1 requests); last: HTTP 503');
    });

    it('points at the container log when the answer says the container exited, and only then', async () => {
      const target = await cloudflareProject();
      const exited = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], {
          runner: stubRunner(cloudflareResponder(false).respond).runner,
          environment: cloudflareEnvironment,
          fetch: () =>
            Promise.resolve(
              new Response(
                'The runner manager container exited (Container exited with unexpected exit code: 1)',
                { status: 503 },
              ),
            ),
          readiness: { ...readiness, windowMs: 0 },
        }),
      );
      expect(exited.message).toContain('The container exited: the reason it printed is in its log');
      expect(exited.message).toContain('acme-ai-control-plane');

      const starting = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], {
          runner: stubRunner(cloudflareResponder(true).respond).runner,
          environment: cloudflareEnvironment,
          fetch: () => Promise.resolve(new Response('starting', { status: 503 })),
          readiness: { ...readiness, windowMs: 0 },
        }),
      );
      expect(starting.message).not.toContain('The container exited');
    });

    describe('then the runner manager', () => {
      const answering = (manager: () => Response) =>
        vi.fn((url: string | URL | Request) =>
          Promise.resolve(
            hrefOf(url).endsWith('/healthz') ? manager() : new Response('', { status: 200 }),
          ),
        );

      it('polls /healthz through 503s after the control plane answers, then reports Applied', async () => {
        const target = await cloudflareProject();
        const { runner } = stubRunner(cloudflareResponder(false).respond);
        const managerAnswers = [503, 503, 200];
        const seen: { url: string; redirect: string | undefined }[] = [];
        const fetchStub = vi.fn((url: string | URL | Request, init?: RequestInit) => {
          const href = hrefOf(url);
          seen.push({ url: href, redirect: init?.redirect });
          return Promise.resolve(
            href === managerHealth
              ? new Response('The runner manager is starting', {
                  status: managerAnswers.shift() ?? 500,
                })
              : new Response('', { status: 200 }),
          );
        });

        const { result, output } = await captured(() =>
          runDeployCommand([target, '--yes'], {
            runner,
            environment: cloudflareEnvironment,
            fetch: fetchStub,
            readiness: { ...readiness, windowMs: 5_000 },
          }),
        );

        expect(result).toEqual({ changes: true, applied: true });
        expect(seen.map(({ url }) => url)).toEqual([
          'https://app.example.com/setup',
          managerHealth,
          managerHealth,
          managerHealth,
        ]);
        expect(seen.every(({ redirect }) => redirect === 'manual')).toBe(true);
        expect(output).toContain(`Waiting for the runner manager at ${managerHealth}`);
        expect(output).toContain('Applied.');
        expect(JSON.stringify(fetchStub.mock.calls)).not.toContain(token);
      });

      it('fails with the Worker name, the URL and the last status when it never answers 200', async () => {
        const target = await cloudflareProject();
        const { runner, calls } = stubRunner(cloudflareResponder(false).respond);
        const fetchStub = answering(
          () => new Response('The runner manager is starting', { status: 503 }),
        );

        const { message, output } = await capturedFailure(() =>
          runDeployCommand([target, '--yes'], {
            runner,
            environment: cloudflareEnvironment,
            fetch: fetchStub,
            readiness,
          }),
        );

        expect(message).toContain(
          `runner manager Worker acme-ai-manager did not answer ${managerHealth}`,
        );
        expect(message).toMatch(/in 0\.25 s \(\d+ requests\); last: HTTP 503/u);
        expect(message).toContain('were applied');
        expect(output).toContain('The runner manager is starting');
        expect(output).not.toContain('Applied.');
        expect(calls.filter(({ args }) => args[0] === 'deploy')).toHaveLength(4);
        expect(`${message}${output}`).not.toContain(token);
        expect(JSON.stringify(fetchStub.mock.calls)).not.toContain(token);
      });

      it('polls the RUNNER_MANAGER_URL custom domain from .env', async () => {
        const target = await cloudflareProject();
        const file = path.join(target, '.env');
        await writeFile(
          file,
          `${await readFile(file, 'utf8')}RUNNER_MANAGER_URL=https://manager.example.com/\n`,
        );
        const fetchStub = answering(() => new Response('ok', { status: 200 }));

        await captured(() =>
          runDeployCommand([target, '--yes'], {
            runner: stubRunner(cloudflareResponder(false).respond).runner,
            environment: cloudflareEnvironment,
            fetch: fetchStub,
            readiness,
          }),
        );

        expect(fetchStub.mock.calls.map(([url]) => hrefOf(url))).toContain(
          'https://manager.example.com/healthz',
        );
        expect(fetchStub.mock.calls.map(([url]) => hrefOf(url))).not.toContain(managerHealth);
      });
    });

    it('makes no request for a plan', async () => {
      const target = await cloudflareProject();
      const fetchStub = vi.fn(() => Promise.resolve(new Response('', { status: 200 })));

      await captured(() =>
        runDeployCommand([target], {
          runner: stubRunner(cloudflareResponder(true).respond).runner,
          environment: cloudflareEnvironment,
          fetch: fetchStub,
          readiness,
        }),
      );

      expect(fetchStub).not.toHaveBeenCalled();
    });
  });

  it('pushes the images, migrates once, deploys gateway, manager and control plane, then retention', async () => {
    const target = await cloudflareProject();
    const env = parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'));
    const { respond, deployed } = cloudflareResponder(false);
    const { runner, calls } = stubRunner(respond);

    const { result, output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(result).toEqual({ changes: true, applied: true });
    expect(summary(calls)).toEqual([
      'wrangler secret list',
      'wrangler containers images',
      'wrangler r2 bucket',
      'docker pull --platform',
      'docker tag registry.example/web@' + digest('1'),
      'wrangler containers push',
      'docker pull --platform',
      'docker tag registry.example/gateway@' + digest('2'),
      'wrangler containers push',
      'docker pull --platform',
      'docker tag registry.example/runner@' + digest('3'),
      'wrangler containers push',
      'docker run --rm',
      'wrangler deploy --config',
      'wrangler secret bulk',
      'wrangler deploy --config',
      'wrangler secret bulk',
      'wrangler deploy --config',
      'wrangler secret bulk',
      'wrangler deploy --config',
      'wrangler secret put',
      'wrangler secret put',
    ]);

    // Content-addressed: the registry tag is the digest, and `linux/amd64` is the platform pulled.
    expect(calls[3]?.args).toEqual([
      'pull',
      '--platform',
      'linux/amd64',
      `registry.example/web@${digest('1')}`,
    ]);
    expect(calls[4]?.args).toEqual([
      'tag',
      `registry.example/web@${digest('1')}`,
      `agent-workspace-web:sha256-${'1'.repeat(64)}`,
    ]);
    expect(calls.filter(({ args }) => args[1] === 'push').map(({ args }) => args[2])).toEqual([
      `agent-workspace-web:sha256-${'1'.repeat(64)}`,
      `agent-workspace-gateway:sha256-${'2'.repeat(64)}`,
      `agent-workspace-runner:sha256-${'3'.repeat(64)}`,
    ]);

    // Each Worker is deployed from a copy that names its registry image; the copy is gone afterwards.
    const deploys = calls.filter(({ args }) => args[0] === 'deploy');
    expect(deploys.map(({ args }) => args[4])).toEqual([
      'acme-ai-gateway',
      'acme-ai-manager',
      'acme-ai-control-plane',
      'acme-ai',
    ]);
    const image = (worker: string) => {
      const containers = z
        .array(z.object({ image: z.string() }))
        .parse(deployed.get(worker)?.['containers']);
      return containers[0]?.image;
    };
    expect(image('acme-ai-gateway')).toBe(registry('gateway', '2'));
    expect(image('acme-ai-manager')).toBe(registry('runner', '3'));
    expect(image('acme-ai-control-plane')).toBe(registry('web', '1'));
    expect(deployed.get('acme-ai-gateway')?.['main']).toBe(
      path.join(target, 'deploy', 'cloudflare', 'gateway-worker.mjs'),
    );
    await expect(access(deploys[0]?.args[2] ?? '')).rejects.toThrow();
    expect(deploys[3]?.args).toEqual([
      'deploy',
      '--config',
      path.join(target, 'deploy', 'cloudflare', 'wrangler.jsonc'),
      '--name',
      'acme-ai',
    ]);

    // Every Worker's secrets in one upload: the JSON on stdin, only names in argv, against the same
    // named copy that was deployed (the responder checks the two are equal).
    expect(bulksOf(calls).map(({ args }) => args.slice(0, 5))).toEqual([
      ['secret', 'bulk', '--name', 'acme-ai-gateway', '--config'],
      ['secret', 'bulk', '--name', 'acme-ai-manager', '--config'],
      ['secret', 'bulk', '--name', 'acme-ai-control-plane', '--config'],
    ]);
    expect(bulksOf(calls).map(({ args }) => args[5])).toEqual(
      deploys.slice(0, 3).map(({ args }) => args[2]),
    );

    // The migration runs the web image's own entry, with its values in the child's environment only.
    const migration = calls.find(({ args }) => args[0] === 'run');
    expect(migration?.args).toContain(`registry.example/web@${digest('1')}`);
    expect(migration?.args).toContain('DATABASE_URL');
    expect(migration?.env['DATABASE_URL']).toBe(databaseUrl);
    expect(migration?.args.join(' ')).toContain(
      'migrate.js && node /srv/packages/core/dist/db/seed.js',
    );

    const controlPlane = controlPlanePuts(calls).map(([name]) => name);
    expect(controlPlanePuts(calls)).toContainEqual([
      'MASTER_ENCRYPTION_KEY',
      env['MASTER_ENCRYPTION_KEY'],
    ]);
    expect(controlPlanePuts(calls)).toContainEqual(['DATABASE_URL', databaseUrl]);
    expect(controlPlanePuts(calls)).toContainEqual([
      'MODEL_GATEWAY_URL',
      'https://acme-ai-gateway.acme.workers.dev',
    ]);
    expect(controlPlanePuts(calls)).toContainEqual([
      'RUNNER_MANAGER_URL',
      'https://acme-ai-manager.acme.workers.dev',
    ]);
    expect(controlPlane).toContain('AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK');
    expect(controlPlane).not.toContain('WEB_IMAGE');
    expect(controlPlane).not.toContain('COMPOSE_PROJECT_NAME');
    expect(controlPlane).not.toContain('AW_FRONTEND_ORIGIN');
    expect(retentionPuts(calls)).toEqual([
      ['CONTROL_PLANE_URL', 'https://app.example.com'],
      ['CRON_SECRET', env['CRON_SECRET']],
    ]);
    for (const call of calls) {
      for (const secret of [...(await secretsOf(target)), token]) {
        expect(call.args.join(' ')).not.toContain(secret);
        expect(output).not.toContain(secret);
      }
    }
  });

  it('gives each Worker only the secrets it needs', async () => {
    const target = await cloudflareProject();
    const env = parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'));
    const { respond } = cloudflareResponder(true);
    const { runner, calls } = stubRunner(respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    const gateway = bulkFor(calls, 'acme-ai-gateway');
    expect(gateway['DATABASE_URL']).toBe(databaseUrl);
    expect(gateway['MASTER_ENCRYPTION_KEY']).toBe(env['MASTER_ENCRYPTION_KEY']);
    expect(gateway['GATEWAY_TOKEN_SECRET']).toBe(env['GATEWAY_TOKEN_SECRET']);

    const manager = bulkFor(calls, 'acme-ai-manager');
    expect(manager).toMatchObject({
      RUNNER_MANAGER_TOKEN: env['RUNNER_MANAGER_TOKEN'],
      RUNTIME_DRIVER: 'cloudflare-sandbox',
      GATEWAY_PUBLIC_URL: 'https://acme-ai-gateway.acme.workers.dev',
      CLOUDFLARE_SANDBOX_BRIDGE_URL: bridgeUrl,
    });
    expect(manager).not.toHaveProperty('MASTER_ENCRYPTION_KEY');
    expect(manager).not.toHaveProperty('DATABASE_URL');
    expect(retentionPuts(calls).map(([name]) => name)).toEqual([
      'CONTROL_PLANE_URL',
      'CRON_SECRET',
    ]);
  });

  it('gives the AW_PUBLIC_URL in .env to the control plane alone (#955)', async () => {
    const target = await cloudflareProject();
    await appendEnv(target, 'AW_PUBLIC_URL', 'https://agents.acme.example');
    const { runner, calls } = stubRunner(cloudflareResponder(true).respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(bulkFor(calls, 'acme-ai-control-plane')['AW_PUBLIC_URL']).toBe(
      'https://agents.acme.example',
    );
    expect(bulkFor(calls, 'acme-ai-gateway')).not.toHaveProperty('AW_PUBLIC_URL');
    expect(bulkFor(calls, 'acme-ai-manager')).not.toHaveProperty('AW_PUBLIC_URL');
    expect(putsOf(calls).map(([name]) => name)).not.toContain('AW_PUBLIC_URL');
  });

  it('does not push an image the registry already holds', async () => {
    const target = await cloudflareProject();
    const tags = [1, 2, 3]
      .map((character) => `agent-workspace-x  sha256-${String(character).repeat(64)}`)
      .join('\n');
    const { respond } = cloudflareResponder(true, { registryTags: tags });
    const { runner, calls } = stubRunner(respond);

    const { output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(calls.filter(({ tool }) => tool === 'docker').map(({ args }) => args[0])).toEqual([
      'run',
    ]);
    expect(calls.some(({ args }) => args[1] === 'push')).toBe(false);
    expect(output).toContain('is already in the Cloudflare registry');
  });

  it('pushes only the image the registry lacks', async () => {
    const target = await cloudflareProject();
    const tags = [1, 3].map((character) => `sha256-${String(character).repeat(64)}`).join('\n');
    const { respond } = cloudflareResponder(true, { registryTags: tags });
    const { runner, calls } = stubRunner(respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(calls.filter(({ args }) => args[1] === 'push').map(({ args }) => args[2])).toEqual([
      `agent-workspace-gateway:sha256-${'2'.repeat(64)}`,
    ]);
  });

  it('runs an image .env already names on registry.cloudflare.com as it is, without a push', async () => {
    const target = await cloudflareProject();
    const onCloudflare = `registry.cloudflare.com/acct123/aw-runner@${digest('3')}`;
    await editEnv(target, 'RUNNER_IMAGE', onCloudflare);
    const { respond, deployed } = cloudflareResponder(true);
    const { runner, calls } = stubRunner(respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(calls.filter(({ args }) => args[1] === 'push').map(({ args }) => args[2])).toEqual([
      `agent-workspace-web:sha256-${'1'.repeat(64)}`,
      `agent-workspace-gateway:sha256-${'2'.repeat(64)}`,
    ]);
    expect(calls.some(({ args }) => args.includes(onCloudflare) && args[0] !== 'run')).toBe(false);
    expect(deployed.get('acme-ai-manager')?.['containers']).toMatchObject([
      { image: onCloudflare },
    ]);
  });

  it('stops before any Wrangler deploy when an image push fails', async () => {
    const target = await cloudflareProject();
    const { respond } = cloudflareResponder(true);
    const { runner, calls } = stubRunner((call) =>
      call.args[0] === 'containers' && call.args[1] === 'push'
        ? { status: 1, stderr: 'push denied' }
        : respond(call),
    );

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(message).toContain('`wrangler containers` failed');
    expect(calls.some(({ args }) => args[0] === 'deploy' || args[0] === 'run')).toBe(false);
    expect(calls.at(-1)?.args.slice(0, 2)).toEqual(['containers', 'push']);
  });

  it('runs an external (E2B) manager stateless, and a cloudflare-sandbox one not', async () => {
    const target = await cloudflareProject();
    const sandbox = stubRunner(cloudflareResponder(true).respond);
    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner: sandbox.runner,
        environment: cloudflareEnvironment,
      }),
    );
    expect(bulkFor(sandbox.calls, 'acme-ai-manager')).not.toHaveProperty(
      'RUNNER_MANAGER_STATELESS',
    );

    await selectExternalRuntime(target);
    await appendEnv(target, 'E2B_RUNTIME_TEMPLATE', e2bTemplate);
    const external = stubRunner(cloudflareResponder(true).respond);
    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner: external.runner,
        environment: cloudflareEnvironment,
      }),
    );
    const externalManager = bulkFor(external.calls, 'acme-ai-manager');
    expect(externalManager['RUNNER_MANAGER_STATELESS']).toBe('true');
    expect(externalManager[runtimeImageKey]).toBe(e2bTemplate);
    expect(bulkFor(external.calls, 'acme-ai-control-plane')).not.toHaveProperty(
      'E2B_RUNTIME_TEMPLATE',
    );
  });

  it('deploys the frontend as static assets and allows exactly its origin on the control plane', async () => {
    const target = await cloudflareProject();
    const web = await frontend();
    const { respond, deployed } = cloudflareResponder(true);
    const { runner, calls } = stubRunner(respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: { ...cloudflareEnvironment, AGENT_WORKSPACE_FRONTEND: web },
      }),
    );

    const deploys = calls.filter(({ args }) => args[0] === 'deploy');
    expect(deploys.map(({ args }) => args[4])).toEqual([
      'acme-ai-gateway',
      'acme-ai-manager',
      'acme-ai-control-plane',
      'acme-ai-web',
    ]);
    const site = deploys[3];
    expect(site?.env['VITE_AW_BASE_URL']).toBe('https://app.example.com');
    expect(deployed.get('acme-ai-web')).toMatchObject({
      workers_dev: true,
      build: { command: 'npm run build', cwd: web },
      assets: { directory: path.join(web, 'dist'), not_found_handling: 'single-page-application' },
    });
    const origin = bulkFor(calls, 'acme-ai-control-plane')['AW_FRONTEND_ORIGIN'];
    expect(origin).toBe('https://acme-ai-web.acme.workers.dev');
    expect(origin).toMatch(/^https:\/\/[^*]+$/u);
    // The frontend goes after the control plane it points at, and holds no secret.
    expect(summary(calls).indexOf('wrangler secret bulk')).toBeLessThan(
      calls.findIndex((call) => call === site),
    );
    expect(bulksOf(calls).map(({ args }) => args[3])).not.toContain('acme-ai-web');
  });

  it('stops before any Wrangler deploy when the migration fails', async () => {
    const target = await cloudflareProject();
    const { respond } = cloudflareResponder(true, { failRun: true });
    const { runner, calls } = stubRunner(respond);

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(message).toContain('`docker run` failed');
    expect(calls.some(({ args }) => args[0] === 'deploy')).toBe(false);
    expect(calls.at(-1)?.args[0]).toBe('run');
  });

  it.each(['DATABASE_URL', 'BOOTSTRAP_ADMIN'])(
    'refuses an apply whose .env has no %s, by name, before any tool runs',
    async (name) => {
      const target = await cloudflareProject();
      await editEnv(target, name, '');
      const { runner, calls } = stubRunner(() => ({}));

      const { message } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
      );

      expect(message).toContain(`${name} is empty in .env`);
      expect(calls).toEqual([]);
    },
  );

  it.each([
    ['RUNNER_MANAGER_TOKEN', '', 'RUNNER_MANAGER_TOKEN is empty in .env'],
    ['GATEWAY_TOKEN_SECRET', '', 'GATEWAY_TOKEN_SECRET is empty in .env'],
    [
      'CLOUDFLARE_SANDBOX_BRIDGE_URL',
      'http://acme-ai-bridge.acme.workers.dev',
      'CLOUDFLARE_SANDBOX_BRIDGE_URL must be an https URL',
    ],
    [
      'CLOUDFLARE_SANDBOX_BRIDGE_URL',
      'https://',
      'CLOUDFLARE_SANDBOX_BRIDGE_URL must be an https URL',
    ],
  ])(
    'refuses an apply whose .env has %s=%j, by name, before any tool runs',
    async (name, value, refusal) => {
      const target = await cloudflareProject();
      await editEnv(target, name, value);
      const { runner, calls } = stubRunner(() => ({}));

      const { message } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
      );

      expect(message).toContain(refusal);
      expect(message).toContain('Nothing was run');
      expect(calls).toEqual([]);
    },
  );

  it.each([
    ['WEB_IMAGE', 'web', 'ghcr.io/acme/web:latest'],
    ['GATEWAY_IMAGE', 'gateway', 'ghcr.io/acme/gateway@sha256:abc'],
    ['RUNNER_IMAGE', 'runner', 'ghcr.io/acme/runner'],
  ])(
    'refuses an image that is not pinned by digest in %s, by name',
    async (name, service, image) => {
      const target = await cloudflareProject();
      await editEnv(target, name, image);
      const { runner, calls } = stubRunner(() => ({}));

      const { message } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
      );

      expect(message).toContain(`the pinned ${service} image must be a non-placeholder sha256`);
      expect(calls).toEqual([]);
    },
  );

  it('requires the sandbox bridge URL for cloudflare-sandbox but not for external', async () => {
    const target = await cloudflareProject();
    await editEnv(target, 'CLOUDFLARE_SANDBOX_BRIDGE_URL', '');
    const refused = stubRunner(() => ({}));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner: refused.runner,
        environment: cloudflareEnvironment,
      }),
    );
    expect(message).toContain('CLOUDFLARE_SANDBOX_BRIDGE_URL is empty in .env');
    expect(refused.calls).toEqual([]);

    // The profile selects E2B; `.env` still says cloudflare-sandbox, which `render` leaves alone.
    await selectExternalRuntime(target);
    await appendEnv(target, 'E2B_RUNTIME_TEMPLATE', e2bTemplate);
    const { respond } = cloudflareResponder(true);
    const accepted = stubRunner(respond);
    const { result } = await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner: accepted.runner,
        environment: cloudflareEnvironment,
      }),
    );
    expect(result).toEqual({ changes: true, applied: true });
    const manager = bulkFor(accepted.calls, 'acme-ai-manager');
    expect(manager['RUNTIME_DRIVER']).toBe('external');
    expect(manager['EXTERNAL_PROVIDER']).toBe('e2b');
    expect(manager).not.toHaveProperty('CLOUDFLARE_SANDBOX_BRIDGE_URL');
  });

  it('fills a blank OBJECT_STORAGE_ENDPOINT with the R2 URL and keeps an explicit one', async () => {
    const target = await cloudflareProject();
    const first = stubRunner(cloudflareResponder(true).respond);
    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner: first.runner,
        environment: cloudflareEnvironment,
      }),
    );
    expect(controlPlanePuts(first.calls)).toContainEqual([
      'OBJECT_STORAGE_ENDPOINT',
      'https://acct123.r2.cloudflarestorage.com',
    ]);

    await editEnv(target, 'OBJECT_STORAGE_ENDPOINT', 'https://eu.example.com');
    const second = stubRunner(cloudflareResponder(true).respond);
    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner: second.runner,
        environment: cloudflareEnvironment,
      }),
    );
    expect(controlPlanePuts(second.calls)).toContainEqual([
      'OBJECT_STORAGE_ENDPOINT',
      'https://eu.example.com',
    ]);
  });

  it('gives the control plane what the secrets service and file storage read', async () => {
    const target = await cloudflareProject();
    await editEnv(target, 'OBJECT_STORAGE_ACCESS_KEY_ID', 'r2-access-key');
    await editEnv(target, 'OBJECT_STORAGE_SECRET_ACCESS_KEY', 'r2-secret-key');
    const { runner, calls } = stubRunner(cloudflareResponder(true).respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    const controlPlane = bulkFor(calls, 'acme-ai-control-plane');
    // `createSecretsService`: a database, and the `local-key` provider's 32-byte hex master key.
    expect(controlPlane['DATABASE_URL']).toBe(databaseUrl);
    expect(controlPlane['MASTER_KEY_PROVIDER']).toBe('local-key');
    expect(controlPlane['MASTER_ENCRYPTION_KEY']).toMatch(/^[0-9a-f]{64}$/iu);
    // The S3 adapter reads `AWS_*`, `OBJECT_STORAGE_*` alone leave R2 without credentials.
    expect(controlPlane).toMatchObject({
      OBJECT_STORAGE_BACKEND: 's3',
      OBJECT_STORAGE_ENDPOINT: 'https://acct123.r2.cloudflarestorage.com',
      AWS_ACCESS_KEY_ID: 'r2-access-key',
      AWS_SECRET_ACCESS_KEY: 'r2-secret-key',
      AWS_REGION: 'auto',
    });
  });

  it.each(['OBJECT_STORAGE_ACCESS_KEY_ID', 'OBJECT_STORAGE_SECRET_ACCESS_KEY'])(
    'refuses an apply whose .env has no %s, by name, before any tool runs',
    async (name) => {
      const target = await cloudflareProject();
      await editEnv(target, name, '');
      const { runner, calls } = stubRunner(() => ({}));

      const { message, output } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
      );

      expect(message).toContain(`${name} is empty in .env`);
      expect(message).toContain('Nothing was run');
      expect(`${message}${output}`).not.toContain('r2-secret-key');
      expect(calls).toEqual([]);
    },
  );

  it('accepts the R2 key pair under the AWS_* names', async () => {
    const target = await cloudflareProject();
    await editEnv(target, 'OBJECT_STORAGE_ACCESS_KEY_ID', '');
    await editEnv(target, 'OBJECT_STORAGE_SECRET_ACCESS_KEY', '');
    const file = path.join(target, '.env');
    await writeFile(
      file,
      `${await readFile(file, 'utf8')}AWS_ACCESS_KEY_ID=aws-key\nAWS_SECRET_ACCESS_KEY=aws-secret\n`,
    );
    const { runner, calls } = stubRunner(cloudflareResponder(true).respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(bulkFor(calls, 'acme-ai-control-plane')).toMatchObject({
      AWS_ACCESS_KEY_ID: 'aws-key',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
    });
  });

  it('does not create an R2 bucket that exists', async () => {
    const target = await cloudflareProject();
    const { runner, calls } = stubRunner(cloudflareResponder(true).respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    const r2 = calls.filter(({ args }) => args[0] === 'r2').map(({ args }) => args.slice(1));
    expect(r2).toEqual([['bucket', 'info', 'acme-ai-files']]);
  });

  it('creates the R2 bucket when it is missing, before the migrations run', async () => {
    const target = await cloudflareProject();
    const { respond } = cloudflareResponder(true, { bucket: 'missing' });
    const { runner, calls } = stubRunner(respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    const names = calls.map(({ tool, args }) => `${tool} ${args.slice(0, 3).join(' ')}`);
    expect(names).toContain('wrangler r2 bucket info');
    const create = names.indexOf('wrangler r2 bucket create');
    expect(calls[create]?.args.at(-1)).toBe('acme-ai-files');
    expect(create).toBeGreaterThan(names.indexOf('wrangler r2 bucket info'));
    expect(create).toBeLessThan(names.findIndex((name) => name.startsWith('docker run')));
  });

  it('does not create a bucket when `r2 bucket info` fails for another reason', async () => {
    const target = await cloudflareProject();
    const { respond } = cloudflareResponder(true, { bucket: 'denied' });
    const { runner, calls } = stubRunner(respond);

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(message).toContain('did not say the bucket is missing');
    expect(calls.some(({ args }) => args[0] === 'r2' && args[2] === 'create')).toBe(false);
    expect(calls.some(({ args }) => args[0] === 'run' || args[0] === 'deploy')).toBe(false);
    expect(calls.some(({ args }) => args[0] === 'pull' || args[1] === 'push')).toBe(false);
  });

  it('refuses an external runtime that is not an E2B template pinned by build id, before any tool runs', async () => {
    const target = await cloudflareProject();
    await selectExternalRuntime(target);
    const { runner, calls } = stubRunner(() => ({}));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(message).toContain('E2B_RUNTIME_TEMPLATE must be an E2B template pinned as');
    expect(message).toContain('Nothing was run');
    expect(calls).toEqual([]);
  });

  it('renders the tool-host flag to the manager and control plane for an external runtime only (#827)', async () => {
    const target = await cloudflareProject();
    await appendEnv(target, 'E2B_TOOL_HOST_TEMPLATE', toolHostTemplate);
    const sandbox = stubRunner(cloudflareResponder(true).respond);
    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner: sandbox.runner,
        environment: cloudflareEnvironment,
      }),
    );
    for (const worker of ['acme-ai-manager', 'acme-ai-control-plane']) {
      const secrets = bulkFor(sandbox.calls, worker);
      expect(secrets, worker).not.toHaveProperty('AGENT_WORKSPACE_TOOL_HOST_IMAGE');
      expect(secrets, worker).not.toHaveProperty('E2B_TOOL_HOST_TEMPLATE');
    }
    expect(bulkFor(sandbox.calls, 'acme-ai-gateway')).not.toHaveProperty('RUNNER_MANAGER_TOKEN');

    await selectExternalRuntime(target);
    await appendEnv(target, 'E2B_RUNTIME_TEMPLATE', e2bTemplate);
    const external = stubRunner(cloudflareResponder(true).respond);
    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner: external.runner,
        environment: cloudflareEnvironment,
      }),
    );
    for (const worker of ['acme-ai-manager', 'acme-ai-control-plane']) {
      const secrets = bulkFor(external.calls, worker);
      expect(secrets['AGENT_WORKSPACE_TOOL_HOST_IMAGE'], worker).toBe(toolHostTemplate);
      expect(secrets, worker).not.toHaveProperty('E2B_TOOL_HOST_TEMPLATE');
    }
    expect(bulkFor(external.calls, 'acme-ai-gateway')['RUNNER_MANAGER_TOKEN']).toBe(
      bulkFor(external.calls, 'acme-ai-manager')['RUNNER_MANAGER_TOKEN'],
    );
  });

  it('refuses an external runtime whose tool-host template is not pinned by build id, by name (#827)', async () => {
    const target = await cloudflareProject();
    await selectExternalRuntime(target);
    await appendEnv(target, 'E2B_RUNTIME_TEMPLATE', e2bTemplate);
    await appendEnv(target, 'E2B_TOOL_HOST_TEMPLATE', 'aw-tool-host');
    const { runner, calls } = stubRunner(() => ({}));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(message).toContain('E2B_TOOL_HOST_TEMPLATE must be an E2B template pinned as');
    expect(message).toContain('Nothing was run');
    expect(calls).toEqual([]);
  });

  it('uses a custom domain from .env for the gateway and manager instead of workers.dev', async () => {
    const target = await cloudflareProject();
    const file = path.join(target, '.env');
    await writeFile(
      file,
      `${await readFile(file, 'utf8')}MODEL_GATEWAY_URL=https://gateway.example.com\nRUNNER_MANAGER_URL=https://manager.example.com\n`,
    );
    const { runner, calls } = stubRunner(cloudflareResponder(true).respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(controlPlanePuts(calls)).toContainEqual([
      'MODEL_GATEWAY_URL',
      'https://gateway.example.com',
    ]);
    expect(controlPlanePuts(calls)).toContainEqual([
      'RUNNER_MANAGER_URL',
      'https://manager.example.com',
    ]);
    expect(bulkFor(calls, 'acme-ai-manager')['GATEWAY_PUBLIC_URL']).toBe(
      'https://gateway.example.com',
    );
  });

  it('puts a rotated secret over the existing one on every apply and never prints it', async () => {
    const target = await cloudflareProject();
    const rotated = 'f'.repeat(64);
    await editEnv(target, 'CRON_SECRET', rotated);
    await editEnv(target, 'MASTER_ENCRYPTION_KEY', rotated);
    const { respond } = cloudflareResponder(true, { listed: ['CONTROL_PLANE_URL', 'CRON_SECRET'] });
    const { runner, calls } = stubRunner(respond);

    const { result, output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(result).toEqual({ changes: true, applied: true });
    const deployed = calls.filter(({ args }) => args[0] === 'deploy').map(({ args }) => args[4]);
    expect(deployed).toEqual(['acme-ai-gateway', 'acme-ai-manager', 'acme-ai-control-plane']);
    expect(retentionPuts(calls)).toContainEqual(['CRON_SECRET', rotated]);
    expect(controlPlanePuts(calls)).toContainEqual(['MASTER_ENCRYPTION_KEY', rotated]);
    expect(bulkFor(calls, 'acme-ai-gateway')['MASTER_ENCRYPTION_KEY']).toBe(rotated);
    expect(retentionPuts(calls).map(([name]) => name)).not.toContain('MASTER_ENCRYPTION_KEY');
    expect(output).not.toContain(rotated);
    for (const call of calls) expect(call.args.join(' ')).not.toContain(rotated);
  });

  it('hands the token to the tool through its environment and never prints it', async () => {
    const target = await cloudflareProject();
    const { respond } = cloudflareResponder(false, { echo: token });
    const { runner, calls } = stubRunner(respond);

    const { output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    const wrangler = calls.filter(({ tool }) => tool === 'wrangler');
    expect(wrangler.length).toBeGreaterThan(5);
    expect(wrangler.every((call) => call.env['CLOUDFLARE_API_TOKEN'] === token)).toBe(true);
    expect(wrangler.every((call) => call.env['CLOUDFLARE_ACCOUNT_ID'] === 'acct123')).toBe(true);
    expect(calls.every((call) => !call.args.join(' ').includes(token))).toBe(true);
    expect(output).not.toContain(token);
  });

  it('does not take a failed secret list for a missing Worker, and redacts what it reports', async () => {
    const target = await cloudflareProject();
    const { runner, calls } = stubRunner(() => ({
      status: 1,
      stderr: `Authentication error [code: 10000] ${token}`,
    }));

    const { message, output } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(message).toContain('did not say the Worker is missing');
    expect(`${message}${output}`).not.toContain(token);
    expect(calls).toHaveLength(1);
  });

  it('refuses --target helm for a Cloudflare profile and --target cloudflare for another cloud', async () => {
    const cloudflare = await project('cloudflare');
    const gcp = await project('gcp');
    const { runner, calls } = stubRunner(() => ({}));

    const helm = await capturedFailure(() =>
      runDeployCommand([cloudflare, '--target', 'helm'], {
        runner,
        environment: cloudflareEnvironment,
      }),
    );
    const other = await capturedFailure(() =>
      runDeployCommand([gcp, '--target', 'cloudflare'], {
        runner,
        environment: cloudflareEnvironment,
      }),
    );

    expect(helm.message).toContain('does not apply to cloud "cloudflare"');
    expect(other.message).toContain('--target cloudflare does not apply to cloud "gcp"');
    expect(calls).toEqual([]);
  });

  it('names agent-workspace doctor when wrangler is not installed', async () => {
    const target = await project('cloudflare');
    const runner: ToolRunner = () =>
      Promise.reject(Object.assign(new Error('spawn wrangler ENOENT'), { code: 'ENOENT' }));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target], { runner, environment: cloudflareEnvironment }),
    );

    expect(message).toContain('wrangler is not installed or not on PATH');
    expect(message).toContain('agent-workspace doctor');
  });
});

describe('agent-workspace deploy output', () => {
  it.each([
    ['local', composeResponder, []],
    ['aws', helmResponder, []],
    ['gcp', terraformResponder, []],
  ] as const)(
    'never prints a .env or profile secret a %s tool echoes',
    async (cloud, responder, extra) => {
      const target = await project(cloud);
      if (cloud === 'gcp') {
        await writeFile(
          path.join(target, 'agent-workspace.yaml'),
          (await readFile(path.join(target, 'agent-workspace.yaml'), 'utf8')).replace(
            /relational: .*/u,
            'relational: postgres://ops:profile-pass-77@db.example:5432/aw',
          ),
        );
      }
      const secrets = [
        ...(await secretsOf(target)),
        ...(cloud === 'gcp' ? ['profile-pass-77'] : []),
      ];
      const echo = `${secrets.join(' ')} postgres://ops:profile-pass-77@db.example:5432/aw`;
      const { runner } = stubRunner(responder(true, echo));
      const infraArguments = cloud === 'local' ? [] : ['--infra', await infra()];

      const { output } = await captured(() =>
        runDeployCommand([target, '--yes', ...infraArguments, ...extra], { runner, environment }),
      );

      expect(output).toContain('***');
      for (const secret of secrets) expect(output).not.toContain(secret);
    },
  );

  it("passes render's own output through the redactor", async () => {
    const target = await project('gcp');
    // An operator key whose value happens to appear in what `render` prints.
    await writeFile(
      path.join(target, '.env'),
      `${await readFile(path.join(target, '.env'), 'utf8')}MY_API_TOKEN=helm/values\n`,
    );
    const infraDirectory = await infra();
    const { runner } = stubRunner(terraformResponder(false));

    const { output } = await captured(() =>
      runDeployCommand([target, '--infra', infraDirectory], { runner, environment }),
    );

    expect(output).toContain('unchanged  deploy/***.yaml');
    expect(output).not.toContain('helm/values');
  });

  it('masks secrets in the output of a failing tool and its refusal', async () => {
    const target = await project('local');
    const secrets = await secretsOf(target);
    const { runner } = stubRunner(() => ({
      status: 1,
      stdout: secrets.join(' '),
      stderr: secrets.join(' '),
    }));

    const { message, output } = await capturedFailure(() =>
      runDeployCommand([target], { runner, environment }),
    );

    for (const secret of secrets) {
      expect(output).not.toContain(secret);
      expect(message).not.toContain(secret);
    }
  });
});

describe('the Compose plan', () => {
  it('reads config hashes and containers', () => {
    expect([...parseServiceHashes('web abc\r\ngateway def\n\n')]).toEqual([
      ['web', 'abc'],
      ['gateway', 'def'],
    ]);
    expect(parseContainers('web\tabc\trunning\ngateway\tdef\texited\n')).toEqual([
      { service: 'web', configHash: 'abc', running: true },
      { service: 'gateway', configHash: 'def', running: false },
    ]);
  });

  it('tells create, recreate, start and unchanged apart', () => {
    const desired = new Map([
      ['web', 'h1'],
      ['gateway', 'h2'],
      ['runner', 'h3'],
      ['postgres', 'h4'],
    ]);
    expect(
      compareComposeServices(desired, [
        { service: 'gateway', configHash: 'old', running: true },
        { service: 'runner', configHash: 'h3', running: false },
        { service: 'postgres', configHash: 'h4', running: true },
      ]),
    ).toEqual([
      ['web', 'create'],
      ['gateway', 'recreate'],
      ['runner', 'start'],
      ['postgres', 'unchanged'],
    ]);
  });
});

describe('the Helm plan', () => {
  it('finds the diff plugin by name only', () => {
    expect(hasDiffPlugin('NAME\tVERSION\tDESCRIPTION\ndiff\t3.9.0\tPreview\n')).toBe(true);
    expect(hasDiffPlugin('NAME\tVERSION\tDESCRIPTION\nsecrets\t4.0\tdiff of secrets\n')).toBe(
      false,
    );
    expect(hasDiffPlugin('diff\n')).toBe(false);
  });

  it('summarises rendered manifests as Kind/name, skipping empty documents', () => {
    expect(
      summarizeManifests(
        '---\nkind: Deployment\nmetadata:\n  name: web\n---\n# empty\n---\nkind: Service\nmetadata:\n  name: gateway\n',
      ),
    ).toEqual(['Deployment/web', 'Service/gateway']);
  });
});
