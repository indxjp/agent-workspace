import { access } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { deployProjectEnvironment, type DeployProjectEnvironmentOptions } from './project.js';
import { projectFixture, digest, docker, deploy } from './project.fixture.test-support.js';
export function defineRefusalsCases(): void {
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
}
