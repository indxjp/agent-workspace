import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { ProfileError } from '../profile.js';
import { deployProjectEnvironment, type DeployProjectEnvironmentOptions } from './project.js';
import type { ToolInvocation, ToolRunner } from './runner.js';
import {
  projectFixture,
  temporary,
  digest,
  images,
  docker,
  deploy,
} from './project.fixture.test-support.js';
export function defineKubernetesCases(): void {
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

    it('carries the project features as deploymentFeatures, and drops the key with them (#1495)', async () => {
      const { options } = await kubernetes({
        project: { ...(await project()), features: ['chat', 'files'] },
      });
      await deployProjectEnvironment(options);
      expect(await overlayOf(options.stateDirectory)).toEqual({
        images: pinned,
        ingress,
        publicUrl: 'https://agents.acme.example',
        deploymentFeatures: 'chat,files',
      });

      await deployProjectEnvironment({ ...options, project: await project() });
      expect(await overlayOf(options.stateDirectory)).not.toHaveProperty('deploymentFeatures');
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

    describe('environments.production.apps (#1512)', () => {
      const app = (name: string, fill: string) => ({
        image: `ghcr.io/acme/${name}@sha256:${fill.repeat(32)}`,
        url: `https://${name}.acme.example`,
      });
      const withApps = async (apps: Record<string, ReturnType<typeof app>>) => {
        const base = await project();
        const production = base.environments.production;
        if (production === undefined) throw new Error('the fixture has a production environment');
        return {
          ...base,
          environments: { ...base.environments, production: { ...production, apps } },
        };
      };

      it('the kubernetes overlay lists the app with schema app_<name>', async () => {
        const { runner } = helm();
        const { options, run } = await kubernetes({
          runner,
          project: await withApps({
            'service-desk': app('service-desk', 'e2'),
            desk: app('desk', 'd1'),
          }),
        });

        const outcome = await run();

        const overlay = await readFile(
          path.join(options.stateDirectory, 'deploy', 'helm', 'values.yaml'),
          'utf8',
        );
        expect(parse(overlay)).toEqual({
          images: pinned,
          ingress,
          publicUrl: 'https://agents.acme.example',
          apps: [
            {
              name: 'desk',
              image: `ghcr.io/acme/desk@sha256:${'d1'.repeat(32)}`,
              host: 'desk.acme.example',
              schema: 'app_desk',
            },
            {
              name: 'service-desk',
              image: `ghcr.io/acme/service-desk@sha256:${'e2'.repeat(32)}`,
              host: 'service-desk.acme.example',
              schema: 'app_service_desk',
            },
          ],
        });
        // The chart's schema is held against these bytes by infra/tests/contracts.test.mjs.
        expect(overlay).toBe(
          await readFile(new URL('fixtures/helm-apps-values.yaml', import.meta.url), 'utf8'),
        );
        expect(overlay).not.toMatch(/SECRET|TOKEN|PASSWORD|DATABASE_URL/u);
        expect(outcome.nextSteps).toContain(
          'next: create Secret agent-workspace-app-desk (docs/deploy/kubernetes.md#apps)',
        );
        expect(outcome.nextSteps).toContain(
          'next: create Secret agent-workspace-app-service-desk (docs/deploy/kubernetes.md#apps)',
        );
      });

      it('drops apps from the overlay when the project lists none', async () => {
        const { options } = await kubernetes({
          project: await withApps({ desk: app('desk', 'd1') }),
        });
        await deployProjectEnvironment(options);
        expect(await overlayOf(options.stateDirectory)).toHaveProperty('apps');

        await deployProjectEnvironment({ ...options, project: await withApps({}) });

        expect(await overlayOf(options.stateDirectory)).not.toHaveProperty('apps');
      });

      it('refuses an app whose Service agent-workspace-app-<name> would pass 63 characters', async () => {
        const name = 'a'.repeat(44);
        const { options, run } = await kubernetes({
          project: await withApps({ [name]: app(name, 'd1') }),
        });

        await expect(run()).rejects.toThrow(
          new ProfileError(
            `environments.production.apps.${name}`,
            'must be named with at most 43 characters for the kubernetes target (its Service is agent-workspace-app-<name>)',
          ),
        );
        await expect(access(path.dirname(options.stateDirectory))).rejects.toThrow();
      });
    });
  });
}
