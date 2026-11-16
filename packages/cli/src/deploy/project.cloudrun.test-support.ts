import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectPolicySchema, type ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { describe, expect, it } from 'vitest';

import type { DeploymentImages } from '../deployment.js';
import { deployProjectEnvironment, type DeployProjectEnvironmentOptions } from './project.js';
import type { ToolInvocation, ToolRunner } from './runner.js';
import {
  projectFixture,
  temporary,
  digest,
  docker,
  deploy,
} from './project.fixture.test-support.js';
export function defineCloudrunCases(): void {
  describe('the gcp-cloudrun target', () => {
    const registry = 'asia-northeast1-docker.pkg.dev/acme-prod/agent-workspace';
    const copied: DeploymentImages = {
      web: `${registry}/web@${digest('1')}`,
      gateway: `${registry}/gateway@${digest('2')}`,
      runner: `${registry}/runner@${digest('3')}`,
      runtime: `${registry}/runtime@${digest('4')}`,
      toolHost: `${registry}/tool-host@${digest('5')}`,
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
      expect(outcome.nextSteps[0]).toBe('web: not up yet; run aw deploy production to bring it up');
      const variables = await readFile(
        path.join(options.stateDirectory, 'deploy', 'terraform', 'gcp-cloudrun.auto.tfvars.json'),
        'utf8',
      );
      expect(JSON.parse(variables)).toMatchObject({
        bootstrap_admin_email: 'owner@acme.example',
        images: {
          web: copied.web,
          gateway: copied.gateway,
          runner: copied.runner,
          runtime: copied.runtime,
          tool_host: copied.toolHost,
        },
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

    it('renders the project features as the module deployment_features (#1495)', async () => {
      const { options, run } = await cloudRun({
        project: { ...(await project()), features: ['chat', 'files'] },
      });

      await run();

      expect(await renderedVariables(options.stateDirectory)).toMatchObject({
        deployment_features: 'chat,files',
      });
    });

    it('renders no deployment_features for a project without features (#1495)', async () => {
      const { options, run } = await cloudRun();

      await run();

      expect(await renderedVariables(options.stateDirectory)).not.toHaveProperty(
        'deployment_features',
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
}
