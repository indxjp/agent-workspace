import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ProjectPolicySchema, type ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { PROJECT_DEPLOY_TARGETS } from '@indx-workspace/contracts/project-file';
import { parseProjectFile } from '@indx-workspace/sdk/project';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { createWorkspace } from '../create.js';
import type { DeploymentImages } from '../deployment.js';
import { parseProfileDocument, ProfileError, renderProfileDocument } from '../profile.js';
import {
  deployProjectEnvironment,
  projectToDeploymentProfile,
  type DeployProjectEnvironmentOptions,
} from './project.js';
import type { ToolInvocation, ToolResult, ToolRunner } from './runner.js';

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

/** The v2 project a fixture holds; a lifted v1 profile fails the test. */
async function projectFixture(name: string) {
  const read = parseProjectFile(await fixture(name));
  if (read.lifted) throw new Error(`${name} is not a v2 project file`);
  return read.project;
}

describe('projectToDeploymentProfile (#621)', () => {
  it('has no v1 profile for the kubernetes target, which installs the chart (#796)', async () => {
    const project = await projectFixture('production-kubernetes.project.yaml');
    expect(() => projectToDeploymentProfile(project, 'production')).toThrow(
      new ProfileError(
        'environments.production.target',
        'kubernetes has no v1 deployment profile; it installs the Helm chart',
      ),
    );
  });

  it.each(PROJECT_DEPLOY_TARGETS.filter((target) => target !== 'kubernetes'))(
    'turns the %s project into its golden v1 profile, byte for byte',
    async (target) => {
      const project = await projectFixture(`production-${target}.project.yaml`);
      const golden = await fixture(`production-${target}.profile.yaml`);

      const profile = projectToDeploymentProfile(project, 'production');

      expect(renderProfileDocument(profile)).toBe(golden);
      expect(parseProfileDocument(golden)).toEqual(profile);
    },
  );

  it('carries the local identity, since production names none', async () => {
    const project = await projectFixture('production-single-vm.project.yaml');
    expect(projectToDeploymentProfile(project, 'production').identity).toEqual(
      project.environments.local.identity,
    );
  });

  it('refuses a project with no production environment, naming the path', async () => {
    const project = await projectFixture('production-single-vm.project.yaml');
    const withoutProduction = {
      ...project,
      environments: { local: project.environments.local },
    };
    expect(() => projectToDeploymentProfile(withoutProduction, 'production')).toThrow(
      new ProfileError('environments.production', 'is not defined; add target and url'),
    );
  });

  it('refuses a gcp-cloudrun project whose name cannot produce a bucket, naming name', async () => {
    const project = await projectFixture('production-gcp-cloudrun.project.yaml');
    const longName = { ...project, name: `a${'-b'.repeat(28)}c` };
    expect(longName.name).toHaveLength(58);
    expect(() => projectToDeploymentProfile(longName, 'production')).toThrow(
      new ProfileError(
        'name',
        'must be at most 57 characters for the gcp-cloudrun target (its bucket is <name>-files)',
      ),
    );
  });
});

describe('deployProjectEnvironment (#621)', () => {
  const temporary: string[] = [];
  const digest = (character: string) => `sha256:${character.repeat(64)}`;
  const images: DeploymentImages = {
    web: `registry.example/web@${digest('1')}`,
    gateway: `registry.example/gateway@${digest('2')}`,
    runner: `registry.example/runner@${digest('3')}`,
    runtime: `registry.example/runtime@${digest('4')}`,
    postgres: `registry.example/postgres@${digest('5')}`,
    seaweedfs: `registry.example/seaweedfs@${digest('6')}`,
  };

  afterEach(async () => {
    await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true })));
    vi.restoreAllMocks();
  });

  /** Docker answering for a project with no container yet; every call is recorded. */
  function docker(answer: Partial<ToolResult> = {}): {
    runner: ToolRunner;
    calls: ToolInvocation[];
  } {
    const calls: ToolInvocation[] = [];
    const runner: ToolRunner = (invocation) => {
      calls.push(invocation);
      const stdout = invocation.args.includes('--hash') ? 'web aaa\n' : '';
      return Promise.resolve({ status: 0, stdout, stderr: '', ...answer });
    };
    return { runner, calls };
  }

  async function deploy(overrides: Partial<DeployProjectEnvironmentOptions> = {}) {
    const home = await mkdtemp(path.join(os.tmpdir(), 'aw-deploy-state-'));
    temporary.push(home);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const options: DeployProjectEnvironmentOptions = {
      project: await projectFixture('production-single-vm.project.yaml'),
      environment: 'production',
      apply: false,
      stateDirectory: path.join(home, 'deployments', 'acme-ai', 'production'),
      env: {},
      images,
      nodeVersion: '24.1.0',
      resolveHost: () => Promise.resolve(),
      ...docker(),
      ...overrides,
    };
    return { options, run: () => deployProjectEnvironment(options) };
  }

  const isComposeUp = ({ args }: ToolInvocation) => args[0] === 'compose' && args[1] === 'up';

  it('refuses a second project of the same name the first one deployed state for (BH061-028)', async () => {
    const first = await mkdtemp(path.join(os.tmpdir(), 'aw-project-a-'));
    const second = await mkdtemp(path.join(os.tmpdir(), 'aw-project-b-'));
    temporary.push(first, second);
    const { options, run } = await deploy({ projectDirectory: first });
    await run();
    const owner = path.join(path.dirname(options.stateDirectory), 'project-directory');
    expect((await readFile(owner, 'utf8')).trim()).toBe(path.resolve(first));

    // The same project again is its own state.
    await deployProjectEnvironment(options);
    const other = deployProjectEnvironment({ ...options, projectDirectory: second });

    await expect(other).rejects.toThrow(`belongs to the project at ${path.resolve(first)}`);
    await expect(other).rejects.toThrow(owner);
  });

  describe('the vercel target (#830)', () => {
    const vercelEnv = { VERCEL_TOKEN: 'tok-not-printed', VERCEL_TEAM_ID: 'team_acme' };

    /** Vercel answering that no project exists yet; every call is recorded. */
    function vercel() {
      const calls: ToolInvocation[] = [];
      const runner: ToolRunner = (invocation) => {
        calls.push(invocation);
        return Promise.resolve(
          invocation.args[1] === 'inspect'
            ? { status: 1, stdout: '', stderr: 'Error: Project not found' }
            : { status: 0, stdout: '', stderr: '' },
        );
      };
      return { runner, calls };
    }

    const inspected = (calls: readonly ToolInvocation[]) =>
      calls.filter(({ args }) => args[1] === 'inspect').map(({ args }) => args[2]);

    it('plans AW_PUBLIC_URL for the control plane alone (#955)', async () => {
      const { runner } = vercel();
      const { run } = await deploy({
        project: await projectFixture('production-vercel.project.yaml'),
        runner,
        env: vercelEnv,
      });

      await run();

      const lines = vi
        .spyOn(process.stdout, 'write')
        .mock.calls.map(([text]) => String(text))
        .join('')
        .split('\n')
        .filter((line) => line.startsWith('Vercel project '));
      const carrying = lines.filter((line) => line.includes('AW_PUBLIC_URL'));
      expect(carrying).toHaveLength(1);
      expect(carrying[0]).toContain('Vercel project acme-ai (control plane');
    });

    it('names the Vercel projects after the project, not the state directory', async () => {
      const { runner, calls } = vercel();
      const { run } = await deploy({
        project: await projectFixture('production-vercel.project.yaml'),
        runner,
        env: vercelEnv,
      });

      await run();

      expect(inspected(calls)).toEqual(['acme-ai-gateway', 'acme-ai-manager', 'acme-ai']);
    });

    it('deploys the web/ frontend as a project of its own, wired to the project url', async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'aw-deploy-project-'));
      temporary.push(directory);
      await mkdir(path.join(directory, 'web'));
      await writeFile(path.join(directory, 'web', 'package.json'), '{}\n');
      const { runner, calls } = vercel();
      const { run } = await deploy({
        project: await projectFixture('production-vercel.project.yaml'),
        runner,
        env: vercelEnv,
        projectDirectory: directory,
      });

      await run();

      expect(inspected(calls)).toEqual([
        'acme-ai-gateway',
        'acme-ai-manager',
        'acme-ai',
        'acme-ai-web',
      ]);
      const output = vi
        .spyOn(process.stdout, 'write')
        .mock.calls.map(([text]) => String(text))
        .join('');
      expect(output).toContain('VITE_AW_BASE_URL');
    });

    it('names the frontend origin to allow only when the project has a web/ frontend', async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'aw-deploy-project-'));
      temporary.push(directory);
      const project = await projectFixture('production-vercel.project.yaml');
      const allowed = (steps: readonly string[]) =>
        steps.some((step) => step.includes('allowedOrigins'));

      const without = await deploy({
        project,
        runner: vercel().runner,
        env: vercelEnv,
        projectDirectory: directory,
      });
      expect(allowed((await without.run()).nextSteps)).toBe(false);

      await mkdir(path.join(directory, 'web'));
      await writeFile(path.join(directory, 'web', 'package.json'), '{}\n');
      const withFrontend = await deploy({
        project,
        runner: vercel().runner,
        env: vercelEnv,
        projectDirectory: directory,
      });
      const [first] = (await withFrontend.run()).nextSteps;
      expect(first).toContain('the control plane allows https://acme-ai-web.vercel.app;');
    });

    it('refuses --infra by name, since it deploys the checkout in AGENT_WORKSPACE_SOURCE', async () => {
      const { runner, calls } = vercel();
      const { run } = await deploy({
        project: await projectFixture('production-vercel.project.yaml'),
        runner,
        env: vercelEnv,
        infraDirectory: '/somewhere/infra',
      });

      await expect(run()).rejects.toThrow('--infra is for the gcp-cloudrun and kubernetes targets');
      expect(calls).toEqual([]);
    });
  });

  it('plans by default: creates the owner-only state, behind the TLS proxy, and runs no up', async () => {
    const { runner, calls } = docker();
    const { options, run } = await deploy({ runner });

    const outcome = await run();

    expect(outcome).toEqual({
      changes: true,
      applied: false,
      created: true,
      adminEmail: 'owner@acme.example',
      envFile: path.join(options.stateDirectory, '.env'),
      moduleDirectory: null,
      nextSteps: [
        'next: caddy reverse-proxy --from agents.acme.example --to 127.0.0.1:3000',
        'next: aw login --url https://agents.acme.example',
        `the Owner is owner@acme.example; the password is BOOTSTRAP_ADMIN_PASSWORD in ${path.join(options.stateDirectory, '.env')}`,
      ],
    });
    expect(calls.some(isComposeUp)).toBe(false);
    const env = await readFile(outcome.envFile, 'utf8');
    expect(env).toContain('\nPORT=127.0.0.1:3000\nAW_TRUSTED_PROXY_HOPS=1\n');
    expect(env).not.toContain('AW_TRUSTED_PROXY_HOPS=0');
    expect((await stat(options.stateDirectory)).mode % 0o1000).toBe(0o700);
    expect((await stat(path.dirname(options.stateDirectory))).mode % 0o1000).toBe(0o700);
    expect((await stat(outcome.envFile)).mode % 0o1000).toBe(0o600);
  });

  it('applies with apply, and never regenerates the secrets of an existing state', async () => {
    const { runner, calls } = docker();
    const { options } = await deploy({ runner });
    const first = await deployProjectEnvironment(options);
    const env = await readFile(first.envFile, 'utf8');

    const second = await deployProjectEnvironment({ ...options, apply: true });

    expect(second).toMatchObject({ changes: true, applied: true, created: false });
    expect(calls.filter(isComposeUp)).toHaveLength(1);
    expect(await readFile(second.envFile, 'utf8')).toBe(env);
  });

  it('hardens .env on the next run when a first run stopped after createWorkspace', async () => {
    const { options, run } = await deploy();
    await mkdir(path.dirname(options.stateDirectory), { recursive: true, mode: 0o700 });
    await createWorkspace(options.stateDirectory, null, {
      images,
      deployState: {
        profile: projectToDeploymentProfile(options.project, 'production'),
        projectName: options.project.name,
      },
    });

    const outcome = await run();

    expect(outcome.created).toBe(false);
    const env = await readFile(outcome.envFile, 'utf8');
    expect(env).toContain('\nPORT=127.0.0.1:3000\nAW_TRUSTED_PROXY_HOPS=1\n');
    expect(env).not.toContain('AW_TRUSTED_PROXY_HOPS=0');
    expect((await stat(outcome.envFile)).mode % 0o1000).toBe(0o600);
  });

  // `$'` would be a replacement pattern if the email were passed to `replace` as a string.
  it.each(['new@acme.example', "o$'x@acme.example"])(
    're-syncs BOOTSTRAP_ADMIN to %s, touching no other line',
    async (email) => {
      const { options } = await deploy();
      const first = await deployProjectEnvironment(options);
      const before = (await readFile(first.envFile, 'utf8')).split('\n');
      const { local } = options.project.environments;
      const renamed = {
        ...options.project,
        environments: {
          ...options.project.environments,
          local: { ...local, identity: { ...local.identity, bootstrapAdmin: email } },
        },
      };

      const second = await deployProjectEnvironment({ ...options, project: renamed });

      expect(second.adminEmail).toBe(email);
      const after = (await readFile(second.envFile, 'utf8')).split('\n');
      expect(after.filter((line) => !before.includes(line))).toEqual([`BOOTSTRAP_ADMIN=${email}`]);
      expect(after).toHaveLength(before.length);
      expect((await stat(second.envFile)).mode % 0o1000).toBe(0o600);
    },
  );

  describe('the project policy (#797)', () => {
    const policy: ProjectPolicy = {
      promotion: { minEvalScore: 0.9 },
      models: ["o'brien-$1 #model"],
      tools: ['orders'],
    };
    const POLICY_KEY = 'AW_DEPLOYMENT_POLICY=';

    const withPolicy = async (value: ProjectPolicy | undefined) => {
      const project = await projectFixture('production-single-vm.project.yaml');
      return { ...project, ...(value === undefined ? {} : { policy: value }) };
    };
    const policyLines = (env: string) =>
      env.split('\n').filter((line) => line.startsWith(POLICY_KEY));

    it('writes the promotion bar into the deployment, canonical and single-quoted', async () => {
      const { options } = await deploy({
        project: await withPolicy({ promotion: { minEvalScore: 0.9 } }),
      });

      const { envFile } = await deployProjectEnvironment(options);

      expect(policyLines(await readFile(envFile, 'utf8'))).toEqual([
        `${POLICY_KEY}'{"promotion":{"minEvalScore":0.9}}'`,
      ]);
    });

    it('writes a value the deployment parses back to exactly the project policy', async () => {
      const { options } = await deploy({ project: await withPolicy(policy) });

      const { envFile } = await deployProjectEnvironment(options);

      const [line] = policyLines(await readFile(envFile, 'utf8'));
      const quoted = line?.slice(POLICY_KEY.length) ?? '';
      expect(quoted).toMatch(/^'.*'$/u);
      const value = quoted.slice(1, -1);
      expect(value).not.toContain("'");
      expect(ProjectPolicySchema.parse(JSON.parse(value))).toEqual(policy);
    });

    it('is byte-identical on a second run', async () => {
      const { options } = await deploy({ project: await withPolicy(policy) });
      const first = await deployProjectEnvironment(options);
      const written = await readFile(first.envFile, 'utf8');

      const second = await deployProjectEnvironment({ ...options, apply: true });

      expect(await readFile(second.envFile, 'utf8')).toBe(written);
    });

    it('follows a changed policy and removes the line when the project drops it', async () => {
      const { options } = await deploy({ project: await withPolicy(policy) });
      await deployProjectEnvironment(options);

      const tightened = await deployProjectEnvironment({
        ...options,
        project: await withPolicy({ promotion: { minEvalScore: 1 } }),
      });
      const tightenedEnv = await readFile(tightened.envFile, 'utf8');
      expect(policyLines(tightenedEnv)).toEqual([
        `${POLICY_KEY}'{"promotion":{"minEvalScore":1}}'`,
      ]);

      const dropped = await deployProjectEnvironment({
        ...options,
        project: await withPolicy(undefined),
      });
      const droppedEnv = await readFile(dropped.envFile, 'utf8');
      expect(policyLines(droppedEnv)).toEqual([]);
      expect(droppedEnv).toBe(tightenedEnv.replace(/AW_DEPLOYMENT_POLICY=.*\n/u, ''));
    });

    it('replaces a hand-set value rather than keeping two', async () => {
      const { options } = await deploy({ project: await withPolicy(policy) });
      const first = await deployProjectEnvironment(options);
      await writeFile(
        first.envFile,
        `${await readFile(first.envFile, 'utf8')}AW_DEPLOYMENT_POLICY={}\n`,
      );

      const second = await deployProjectEnvironment(options);

      expect(policyLines(await readFile(second.envFile, 'utf8'))).toHaveLength(1);
    });

    it('is forwarded to the web service by the Compose template', async () => {
      const compose = await readFile(
        new URL('../../templates/compose.yaml', import.meta.url),
        'utf8',
      );
      expect(compose).toContain('AW_DEPLOYMENT_POLICY: ${AW_DEPLOYMENT_POLICY:-}');
    });
  });

  describe('the public URL (#955)', () => {
    const URL_KEY = 'AW_PUBLIC_URL=';
    const urlLines = (env: string) => env.split('\n').filter((line) => line.startsWith(URL_KEY));

    it('writes the production origin, once, after its comment, and forwards it to web', async () => {
      const { options } = await deploy();

      const { envFile } = await deployProjectEnvironment(options);

      const env = await readFile(envFile, 'utf8');
      expect(urlLines(env)).toEqual([`${URL_KEY}https://agents.acme.example`]);
      expect(env).toMatch(/^# Public https origin of this deployment .*\nAW_PUBLIC_URL=/mu);
      const compose = await readFile(
        new URL('../../templates/compose.yaml', import.meta.url),
        'utf8',
      );
      expect(compose).toContain('AW_PUBLIC_URL: ${AW_PUBLIC_URL:-}');
    });

    it('is byte-identical on a second run', async () => {
      const { options } = await deploy();
      const first = await deployProjectEnvironment(options);
      const written = await readFile(first.envFile, 'utf8');

      const second = await deployProjectEnvironment({ ...options, apply: true });

      expect(await readFile(second.envFile, 'utf8')).toBe(written);
    });

    it('follows a changed url without keeping two lines or two comments', async () => {
      const { options } = await deploy();
      await deployProjectEnvironment(options);

      const moved = await deployProjectEnvironment({
        ...options,
        project: {
          ...options.project,
          environments: {
            ...options.project.environments,
            production: {
              target: 'single-vm',
              url: 'https://moved.acme.example',
            },
          },
        },
      });

      const env = await readFile(moved.envFile, 'utf8');
      expect(urlLines(env)).toEqual(['AW_PUBLIC_URL=https://moved.acme.example']);
      expect(env.match(/^# Public https origin/gmu)).toHaveLength(1);
    });
  });

  it('refuses unresolvable release images before anything is created', async () => {
    const { options } = await deploy();
    const unpinned: DeployProjectEnvironmentOptions = {
      project: options.project,
      environment: 'production',
      apply: false,
      stateDirectory: options.stateDirectory,
      env: { AW_WEB_IMAGE: `registry.example/web@${digest('0')}` },
      nodeVersion: '24.1.0',
      runner: docker().runner,
    };

    await expect(deployProjectEnvironment(unpinned)).rejects.toThrow(
      'must be a non-placeholder sha256 digest reference',
    );
    await expect(access(path.dirname(options.stateDirectory))).rejects.toThrow();
  });

  it.each([
    [
      'a missing production environment',
      async () => {
        const project = await projectFixture('production-single-vm.project.yaml');
        return { project: { ...project, environments: { local: project.environments.local } } };
      },
      'is not defined; add target and url',
    ],
    [
      '--infra, which only gcp-cloudrun takes',
      () => Promise.resolve({ infraDirectory: '/srv/infra' }),
      '--infra is for the gcp-cloudrun target',
    ],
    ['Node.js before 24', () => Promise.resolve({ nodeVersion: '22.11.0' }), 'Node.js 24'],
    [
      'Docker missing from PATH',
      () =>
        Promise.resolve({
          runner: () => Promise.reject(Object.assign(new Error('spawn'), { code: 'ENOENT' })),
        }),
      'Docker Engine is not installed',
    ],
    [
      'the Compose plugin missing',
      () => Promise.resolve({ runner: docker({ status: 1 }).runner }),
      'Install docker-compose-plugin',
    ],
    [
      'a url host with no DNS record, on apply',
      () =>
        Promise.resolve({
          apply: true,
          resolveHost: () => Promise.reject(new Error('ENOTFOUND')),
        }),
      'agents.acme.example does not resolve',
    ],
  ])('refuses %s before anything is created', async (_, overrides, message) => {
    const { options, run } = await deploy(await overrides());

    await expect(run()).rejects.toThrow(message);
    await expect(access(path.dirname(options.stateDirectory))).rejects.toThrow();
  });

  describe('the gcp-cloudrun target', () => {
    const registry = 'asia-northeast1-docker.pkg.dev/acme-prod/agent-workspace';
    const copied: DeploymentImages = {
      web: `${registry}/web@${digest('1')}`,
      gateway: `${registry}/gateway@${digest('2')}`,
      runner: `${registry}/runner@${digest('3')}`,
      runtime: `${registry}/runtime@${digest('4')}`,
    };

    /** An initialised module checkout, with `project_id` in its `terraform.tfvars` unless not. */
    async function moduleCheckout(tfvars = 'project_id = "acme-prod"\n'): Promise<string> {
      const infra = await mkdtemp(path.join(os.tmpdir(), 'aw-deploy-infra-'));
      temporary.push(infra);
      const module = path.join(infra, 'terraform', 'gcp-cloudrun');
      await mkdir(path.join(module, '.terraform'), { recursive: true });
      await writeFile(path.join(module, 'main.tf'), '');
      await writeFile(path.join(module, 'terraform.tfvars'), tfvars);
      return infra;
    }

    const project = () => projectFixture('production-gcp-cloudrun.project.yaml');

    async function cloudRun(overrides: Partial<DeployProjectEnvironmentOptions> = {}) {
      return deploy({
        project: await project(),
        infraDirectory: await moduleCheckout(),
        images: copied,
        ...overrides,
      });
    }

    const isTerraformPlan = ({ tool, args }: ToolInvocation) =>
      tool === 'terraform' && args[1] === 'plan';

    it('plans through terraform plan in the module --infra names, applying nothing', async () => {
      const calls: ToolInvocation[] = [];
      const runner: ToolRunner = (invocation) => {
        calls.push(invocation);
        const status = isTerraformPlan(invocation) ? 2 : 0;
        return Promise.resolve({ status, stdout: '', stderr: '' });
      };
      const { options, run } = await cloudRun({ runner });

      const outcome = await run();

      expect(outcome).toMatchObject({ changes: true, applied: false, created: true });
      const plan = calls.find(isTerraformPlan);
      expect(plan?.args[0]).toBe(
        `-chdir=${path.join(options.infraDirectory ?? '', 'terraform', 'gcp-cloudrun')}`,
      );
      expect(calls.some(({ args }) => args[0] === 'apply' || args[1] === 'apply')).toBe(false);
      expect(outcome.nextSteps[0]).toContain(
        `-chdir=${path.join(options.infraDirectory ?? '', 'terraform', 'gcp-cloudrun')} output web_url`,
      );
      const variables = await readFile(
        path.join(options.stateDirectory, 'deploy', 'terraform', 'gcp-cloudrun.auto.tfvars.json'),
        'utf8',
      );
      expect(JSON.parse(variables)).toMatchObject({
        bootstrap_admin_email: 'owner@acme.example',
        images: copied,
      });
      expect(await readFile(outcome.envFile, 'utf8')).not.toContain('PORT=127.0.0.1:3000');
    });

    const renderedVariables = async (stateDirectory: string): Promise<unknown> =>
      JSON.parse(
        await readFile(
          path.join(stateDirectory, 'deploy', 'terraform', 'gcp-cloudrun.auto.tfvars.json'),
          'utf8',
        ),
      );

    it('renders the project policy as the module deployment_policy (#797)', async () => {
      const policy: ProjectPolicy = { promotion: { minEvalScore: 0.9 }, models: ["o'brien"] };
      const { options, run } = await cloudRun({ project: { ...(await project()), policy } });

      await run();

      const rendered = '{"models":["o\\u0027brien"],"promotion":{"minEvalScore":0.9}}';
      expect(await renderedVariables(options.stateDirectory)).toMatchObject({
        deployment_policy: rendered,
      });
      expect(ProjectPolicySchema.parse(JSON.parse(rendered))).toEqual(policy);
    });

    it('renders the production origin as the module public_url (#955)', async () => {
      const { options, run } = await cloudRun();

      await run();

      expect(await renderedVariables(options.stateDirectory)).toMatchObject({
        public_url: 'https://agents.acme.example',
      });
    });

    it('renders no deployment_policy for a project without a bar (#797)', async () => {
      const { options, run } = await cloudRun();

      await run();

      expect(await renderedVariables(options.stateDirectory)).not.toHaveProperty(
        'deployment_policy',
      );
    });

    it('takes project_id from TF_VAR_project_id when terraform.tfvars has none', async () => {
      const { run } = await cloudRun({
        infraDirectory: await moduleCheckout('region = "europe-west1"\n'),
        env: { TF_VAR_project_id: 'acme-prod' },
      });
      await expect(run()).resolves.toMatchObject({ created: true });
    });

    it.each([
      [
        'an --infra with no module',
        async () => ({
          project: await project(),
          images: copied,
          infraDirectory: path.join(os.tmpdir(), 'aw-no-such-infra'),
        }),
        'holds no Terraform module',
      ],
      [
        'a module with no project_id',
        async () => ({
          project: await project(),
          images: copied,
          infraDirectory: await moduleCheckout('region = "europe-west1"\n'),
        }),
        'The gcp-cloudrun module has no project_id',
      ],
      [
        'Terraform missing from PATH',
        async () => ({
          project: await project(),
          images: copied,
          infraDirectory: await moduleCheckout(),
          runner: () => Promise.reject(Object.assign(new Error('spawn'), { code: 'ENOENT' })),
        }),
        'Terraform is not installed',
      ],
    ])('refuses %s before anything is created or planned', async (_, overrides, message) => {
      const { runner, calls } = docker();
      // Not `deploy`'s options as they are: a case without `images` must have none.
      const { stateDirectory } = (await deploy()).options;
      const options: DeployProjectEnvironmentOptions = {
        environment: 'production',
        apply: false,
        stateDirectory,
        env: {},
        nodeVersion: '24.1.0',
        runner,
        ...(await overrides()),
      };
      const run = () => deployProjectEnvironment(options);

      await expect(run()).rejects.toThrow(message);
      expect(calls.some(isTerraformPlan)).toBe(false);
      await expect(access(path.dirname(options.stateDirectory))).rejects.toThrow();
    });
  });

  describe('the kubernetes target (#796)', () => {
    /** An `infra/` whose chart directory exists. */
    async function chartCheckout(): Promise<string> {
      const infra = await mkdtemp(path.join(os.tmpdir(), 'aw-deploy-chart-'));
      temporary.push(infra);
      await mkdir(path.join(infra, 'helm', 'agent-workspace'), { recursive: true });
      await writeFile(path.join(infra, 'helm', 'agent-workspace', 'Chart.yaml'), 'name: x\n');
      return infra;
    }

    /** Helm without the diff plugin; every call is recorded. */
    function helm(): { runner: ToolRunner; calls: ToolInvocation[] } {
      const calls: ToolInvocation[] = [];
      const runner: ToolRunner = (invocation) => {
        calls.push(invocation);
        const stdout = invocation.args[0] === 'plugin' ? 'NAME\tVERSION\tDESCRIPTION\n' : '';
        return Promise.resolve({ status: 0, stdout, stderr: '' });
      };
      return { runner, calls };
    }

    const project = () => projectFixture('production-kubernetes.project.yaml');
    const overlayOf = async (stateDirectory: string): Promise<unknown> =>
      parse(await readFile(path.join(stateDirectory, 'deploy', 'helm', 'values.yaml'), 'utf8'));
    const pinned = {
      web: images.web,
      gateway: images.gateway,
      runnerManager: images.runner,
      runtime: { 'claude-agent-sdk': images.runtime },
    };
    const ingress = { enabled: true, host: 'agents.acme.example' };

    async function kubernetes(overrides: Partial<DeployProjectEnvironmentOptions> = {}) {
      return deploy({
        project: await project(),
        infraDirectory: await chartCheckout(),
        runner: helm().runner,
        ...overrides,
      });
    }

    it('plans with helm template over the chart values and the overlay, applying nothing', async () => {
      const { runner, calls } = helm();
      const { options, run } = await kubernetes({ runner });

      const outcome = await run();

      expect(outcome).toMatchObject({ changes: true, applied: false, created: true });
      const chart = path.join(options.infraDirectory ?? '', 'helm', 'agent-workspace');
      const overlayFile = path.join(options.stateDirectory, 'deploy', 'helm', 'values.yaml');
      expect(calls.map(({ tool, args }) => [tool, args[0]])).toEqual([
        ['helm', 'version'],
        ['helm', 'plugin'],
        ['helm', 'template'],
      ]);
      expect(calls[2]?.args).toEqual([
        'template',
        'agent-workspace',
        chart,
        '--namespace',
        'agent-workspace',
        '-f',
        path.join(chart, 'values.yaml'),
        '-f',
        overlayFile,
      ]);
      expect(await overlayOf(options.stateDirectory)).toEqual({
        images: pinned,
        ingress,
        publicUrl: 'https://agents.acme.example',
      });
      await expect(access(path.join(options.stateDirectory, '.env'))).rejects.toThrow();
    });

    it('installs the release with --wait on apply', async () => {
      const { runner, calls } = helm();
      const { run } = await kubernetes({ runner, apply: true });

      const outcome = await run();

      expect(outcome).toMatchObject({
        changes: true,
        applied: true,
        moduleDirectory: null,
        adminEmail: 'owner@acme.example',
      });
      expect(outcome.nextSteps).toContainEqual(
        expect.stringContaining('kubectl -n agent-workspace get ingress'),
      );

      const install = calls.find(({ args }) => args[0] === 'upgrade');
      expect(install?.args.slice(0, 2)).toEqual(['upgrade', '--install']);
      expect(install?.args.slice(-2)).toEqual(['--create-namespace', '--wait']);
    });

    it('carries the project policy and rewrites only that key when it changes', async () => {
      const policy: ProjectPolicy = { promotion: { minEvalScore: 0.9 }, models: ["o'brien"] };
      const { options } = await kubernetes({ project: { ...(await project()), policy } });
      await deployProjectEnvironment(options);
      expect(await overlayOf(options.stateDirectory)).toEqual({
        images: pinned,
        ingress,
        publicUrl: 'https://agents.acme.example',
        deploymentPolicy: '{"models":["o\'brien"],"promotion":{"minEvalScore":0.9}}',
      });

      await deployProjectEnvironment({
        ...options,
        project: { ...(await project()), policy: { promotion: { minEvalScore: 1 } } },
      });

      expect(await overlayOf(options.stateDirectory)).toEqual({
        images: pinned,
        ingress,
        publicUrl: 'https://agents.acme.example',
        deploymentPolicy: '{"promotion":{"minEvalScore":1}}',
      });

      await deployProjectEnvironment({ ...options, project: await project() });
      expect(await overlayOf(options.stateDirectory)).not.toHaveProperty('deploymentPolicy');
    });

    it('keeps the images a first run pinned, and writes no credential', async () => {
      const { options } = await kubernetes();
      await deployProjectEnvironment(options);
      const first = await readFile(
        path.join(options.stateDirectory, 'deploy', 'helm', 'values.yaml'),
        'utf8',
      );

      await deployProjectEnvironment({
        ...options,
        images: { ...images, web: `registry.example/web@${digest('9')}` },
      });

      expect(
        await readFile(path.join(options.stateDirectory, 'deploy', 'helm', 'values.yaml'), 'utf8'),
      ).toBe(first);
      expect(first).not.toMatch(/SECRET|TOKEN|PASSWORD|DATABASE_URL/u);
    });

    it('takes the ingress class and cert-manager issuer from the environment, and keeps them', async () => {
      const { options } = await kubernetes({
        env: { AW_INGRESS_CLASS_NAME: 'nginx', AW_TLS_CLUSTER_ISSUER: 'letsencrypt' },
      });
      await deployProjectEnvironment(options);
      const chosen = { ...ingress, className: 'nginx', tls: { clusterIssuer: 'letsencrypt' } };
      expect(await overlayOf(options.stateDirectory)).toMatchObject({ ingress: chosen });

      await deployProjectEnvironment({ ...options, env: {} });

      expect(await overlayOf(options.stateDirectory)).toMatchObject({ ingress: chosen });
    });

    it('narrows database egress to AW_DATABASE_CIDR and keeps it, warning only while it is unset', async () => {
      const { options } = await kubernetes();
      const stderr = vi.spyOn(process.stderr, 'write');
      const warnings = () =>
        stderr.mock.calls.filter(([message]) => String(message).includes('AW_DATABASE_CIDR'));
      await deployProjectEnvironment(options);
      expect(warnings()).toHaveLength(1);
      expect(String(warnings()[0]?.[0])).toContain('open to any address');
      expect(await overlayOf(options.stateDirectory)).not.toHaveProperty('database');

      await deployProjectEnvironment({ ...options, env: { AW_DATABASE_CIDR: '10.20.0.0/24' } });
      await deployProjectEnvironment({ ...options, env: {} });

      expect(warnings()).toHaveLength(1);
      expect(await overlayOf(options.stateDirectory)).toMatchObject({
        database: { cidr: '10.20.0.0/24' },
      });
    });

    it('refuses an AW_DATABASE_CIDR that is not a CIDR before anything is written', async () => {
      const { options, run } = await kubernetes({ env: { AW_DATABASE_CIDR: '10.20.0.0' } });

      await expect(run()).rejects.toThrow('AW_DATABASE_CIDR must be a CIDR');
      await expect(access(path.dirname(options.stateDirectory))).rejects.toThrow();
    });

    it('passes the operator values file (AW_HELM_VALUES) between the chart values and the overlay', async () => {
      const { runner, calls } = helm();
      const operatorFile = path.join(await chartCheckout(), 'operator-values.yaml');
      await writeFile(operatorFile, 'runtime:\n  driver: kubernetes\n');
      const { options, run } = await kubernetes({ runner, env: { AW_HELM_VALUES: operatorFile } });

      await run();

      const chart = path.join(options.infraDirectory ?? '', 'helm', 'agent-workspace');
      const overlayFile = path.join(options.stateDirectory, 'deploy', 'helm', 'values.yaml');
      expect(calls.at(-1)?.args.slice(-6)).toEqual([
        '-f',
        path.join(chart, 'values.yaml'),
        '-f',
        operatorFile,
        '-f',
        overlayFile,
      ]);
    });

    it('refuses an AW_HELM_VALUES that names no file before anything is written', async () => {
      const { options, run } = await kubernetes({
        env: { AW_HELM_VALUES: '/nonexistent/values.yaml' },
      });

      await expect(run()).rejects.toThrow('AW_HELM_VALUES names /nonexistent/values.yaml');
      await expect(access(path.dirname(options.stateDirectory))).rejects.toThrow();
    });

    it('refuses an AW_HELM_VALUES that names a directory before anything is written', async () => {
      const directory = await chartCheckout();
      const { options, run } = await kubernetes({ env: { AW_HELM_VALUES: directory } });

      await expect(run()).rejects.toThrow(`AW_HELM_VALUES names ${directory}, which is not a file`);
      await expect(access(path.dirname(options.stateDirectory))).rejects.toThrow();
    });

    it('installs the chart shipped with the CLI when there is no --infra (BH061-031)', async () => {
      const { runner, calls } = helm();
      const { run } = await deploy({ project: await project(), runner });

      await run();

      const shipped = fileURLToPath(
        new URL('../../modules/helm/agent-workspace/', import.meta.url),
      );
      expect(calls[2]?.args.slice(0, 3)).toEqual(['template', 'agent-workspace', shipped]);
      await expect(access(path.join(shipped, 'Chart.yaml'))).resolves.toBeUndefined();
    });

    it.each([
      [
        'an --infra with no chart',
        { infraDirectory: path.join(os.tmpdir(), 'aw-no-such-infra') },
        'holds no Helm chart',
      ],
      [
        'Helm missing from PATH',
        { runner: () => Promise.reject(Object.assign(new Error('spawn'), { code: 'ENOENT' })) },
        'Helm is not installed',
      ],
      ['Helm failing', { runner: docker({ status: 1 }).runner }, '`helm version` failed'],
      ['Node.js before 24', { nodeVersion: '22.11.0' }, 'Node.js 24'],
    ])('refuses %s before anything is written', async (_, overrides, message) => {
      const { options, run } = await kubernetes(overrides);

      await expect(run()).rejects.toThrow(message);
      await expect(access(path.dirname(options.stateDirectory))).rejects.toThrow();
    });
  });
});
