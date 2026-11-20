import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { runCli, tempFile } from '../testing.js';

import {
  PROJECT,
  deployedWith,
  emptyDirectory,
  outcome,
  project,
  resetDeployFixtures,
} from './deploy.test-support.js';
import { deployMocks } from './deploy.mocks.test-support.js';

vi.mock(
  '@indx-workspace/cli/deploy',
  async () => (await import('./deploy.mocks.test-support.js')).deployMocks,
);

const { deployProjectEnvironment } = deployMocks;

afterEach(resetDeployFixtures);

const WITHOUT_PRODUCTION = PROJECT.replace(/ {2}production:\n.*\n.*\n/u, '');

describe('aw deploy refusals', () => {
  it('lists every deploy target when the project has no production environment (#796)', async () => {
    const cwd = await project(WITHOUT_PRODUCTION);

    const run = await runCli(['deploy', 'production'], { cwd, homeDir: '/home/owner' });

    expect(run.stderr).toContain('single-vm | gcp-cloudrun | kubernetes | vercel');
    expect(deployProjectEnvironment).not.toHaveBeenCalled();
  });

  it.each([
    [['deploy', 'production', '--plan', '--yes'], '--plan and --yes contradict'],
    [['deploy'], 'missing <environment>'],
    [['deploy', 'staging'], '<environment> must be production'],
  ])('refuses %j as a usage error', async (argv, message) => {
    const run = await runCli(argv, { cwd: await project() });

    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain(message);
    expect(deployProjectEnvironment).not.toHaveBeenCalled();
  });

  it.each([
    ['local', PROJECT, 'the local environment is not deployed', 'fix: aw dev'],
    [
      'production',
      WITHOUT_PRODUCTION,
      'agent-workspace.yaml has no environments.production',
      'fix: add production:',
    ],
    [
      'production',
      'apiVersion: agentworkspace.dev/v1\nkind: Deployment\ncloud: local\nstorage:\n  relational: compose-postgres\n  objects: local-filesystem\n  secrets: local-key\nruntime:\n  default: docker\nidentity:\n  bootstrapAdmin: admin@localhost.test\n',
      'is a v1 deployment profile',
      'fix: agent-workspace deploy',
    ],
  ])('refuses %s with %#, before any deploy step', async (environment, text, message, fix) => {
    const run = await runCli(['deploy', environment], { cwd: await project(text) });

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain(message);
    expect(run.stderr).toContain(fix);
    expect(deployProjectEnvironment).not.toHaveBeenCalled();
  });

  it('refuses a directory with no project file', async () => {
    const cwd = await emptyDirectory();

    const run = await runCli(['deploy', 'production'], { cwd });

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('no agent-workspace.yaml in this directory');
  });
});

describe('apps in aw-generated.json (#1512)', () => {
  const IMAGE = `ghcr.io/acme/desk@sha256:${'a1'.repeat(32)}`;
  const MANIFEST = JSON.stringify({
    version: 1,
    entries: {
      'app:desk': { files: {}, edits: [] },
      'resource:ticket': { files: {}, edits: [] },
    },
  });
  const withApps = (apps: string): string =>
    PROJECT.replace(
      '    url: https://agents.acme.example\n',
      `    url: https://agents.acme.example\n${apps}`,
    );
  const deployFrom = (cwd: string) =>
    runCli(['deploy', 'production'], { cwd, homeDir: '/home/owner' });

  it('refuses an app in aw-generated.json missing from environments.production.apps', async () => {
    const cwd = await project();
    await tempFile(cwd, 'aw-generated.json', MANIFEST);

    const run = await deployFrom(cwd);

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain(
      'the project has app desk but environments.production.apps.desk is not set',
    );
    expect(run.stderr).toContain(
      'fix: add apps: { desk: { image: <registry>/desk@sha256:…, url: https://<host> } } under environments.production',
    );
    expect(deployProjectEnvironment).not.toHaveBeenCalled();
  });

  it('deploys when every generated app is listed', async () => {
    deployProjectEnvironment.mockResolvedValue(outcome(false, false));
    const cwd = await project(
      withApps(
        `    apps:\n      desk:\n        image: ${IMAGE}\n        url: https://desk.acme.example\n`,
      ),
    );
    await tempFile(cwd, 'aw-generated.json', MANIFEST);

    const run = await deployFrom(cwd);

    expect(run.stderr).toBe('');
    expect(deployedWith().project.environments.production?.apps).toEqual({
      desk: { image: IMAGE, url: 'https://desk.acme.example' },
    });
  });

  it('deploys a project with no aw-generated.json as one with no apps', async () => {
    deployProjectEnvironment.mockResolvedValue(outcome(false, false));

    const run = await runCli(['deploy', 'production'], { cwd: await project() });

    expect(run.code).toBe(EXIT_CODE.ok);
  });

  it('refuses an aw-generated.json the manifest parser refuses, before any deploy step', async () => {
    const cwd = await project();
    await tempFile(cwd, 'aw-generated.json', '{"version":1,"entries":{},"extra":true}');

    const run = await deployFrom(cwd);

    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('aw-generated.json');
    expect(deployProjectEnvironment).not.toHaveBeenCalled();
  });
});
