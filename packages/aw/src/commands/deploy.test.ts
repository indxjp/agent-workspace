import { rm } from 'node:fs/promises';
import path from 'node:path';

import type {
  DeployProjectEnvironmentOptions,
  ProjectDeployOutcome,
} from '@indx-workspace/cli/deploy';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { runCli, tempDirectory, tempFile } from '../testing.js';

const deployProjectEnvironment = vi.hoisted(() =>
  vi.fn<(options: DeployProjectEnvironmentOptions) => Promise<ProjectDeployOutcome>>(),
);
vi.mock('@indx-workspace/cli/deploy', () => ({ deployProjectEnvironment }));

const PROJECT = [
  'apiVersion: agentworkspace.dev/v2',
  'kind: Project',
  'name: acme-ai',
  'environments:',
  '  local:',
  '    cloud: local',
  '    identity:',
  '      bootstrapAdmin: admin@localhost.test',
  '  production:',
  '    target: single-vm',
  '    url: https://agents.acme.example',
  '',
].join('\n');

const temporary: string[] = [];

afterEach(async () => {
  deployProjectEnvironment.mockReset();
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true });
});

async function project(text = PROJECT): Promise<string> {
  const directory = await tempDirectory();
  temporary.push(directory);
  await tempFile(directory, 'agent-workspace.yaml', text);
  return directory;
}

function outcome(changes: boolean, applied: boolean): ProjectDeployOutcome {
  return {
    changes,
    applied,
    created: true,
    adminEmail: 'admin@localhost.test',
    envFile: '/home/owner/.config/agent-workspace/deployments/acme-ai/production/.env',
    moduleDirectory: null,
    nextSteps: ['next: a', 'next: b'],
  };
}

function deployedWith(): DeployProjectEnvironmentOptions {
  const [options] = deployProjectEnvironment.mock.calls[0] ?? [];
  if (options === undefined) throw new Error('deployProjectEnvironment was not called');
  return options;
}

describe('aw deploy (#621)', () => {
  it('plans by default, into the state directory, and exits 3 when changes are pending', async () => {
    deployProjectEnvironment.mockResolvedValue(outcome(true, false));
    const cwd = await project();

    const run = await runCli(['deploy', 'production'], { cwd, homeDir: '/home/owner' });

    expect(run.code).toBe(EXIT_CODE.contract);
    expect(run.stderr).toBe('error: changes are pending; re-run with --yes to apply them\n');
    expect(deployedWith()).toMatchObject({
      environment: 'production',
      apply: false,
      stateDirectory: path.join(
        '/home/owner',
        '.config',
        'agent-workspace',
        'deployments',
        'acme-ai',
        'production',
      ),
    });
    expect(deployedWith().project.name).toBe('acme-ai');
  });

  it("applies with --yes and prints the outcome's next steps verbatim, in order", async () => {
    deployProjectEnvironment.mockResolvedValue(outcome(true, true));
    const cwd = await project();

    const run = await runCli(['deploy', 'production', '--yes'], { cwd, homeDir: '/home/owner' });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(deployedWith().apply).toBe(true);
    expect(run.stdout).toBe(
      `deployed production from ${path.join('/home/owner', '.config', 'agent-workspace', 'deployments', 'acme-ai', 'production')}\nnext: a\nnext: b\n`,
    );
  });

  it('sends --yes back to --plan when it stopped before applying, as after a Cloud Run image copy (#794)', async () => {
    deployProjectEnvironment.mockResolvedValue(outcome(true, false));
    const cwd = await project();

    const run = await runCli(['deploy', 'production', '--yes'], { cwd, homeDir: '/home/owner' });

    expect(run.code).toBe(EXIT_CODE.contract);
    expect(run.stderr).toBe(
      'error: nothing was applied; run --plan to review the changes, then --yes\n',
    );
    expect(run.stdout).not.toContain('deployed');
  });

  it('passes --infra resolved from the project directory', async () => {
    const cwd = await project(PROJECT.replace('target: single-vm', 'target: gcp-cloudrun'));
    deployProjectEnvironment.mockResolvedValue(outcome(true, true));

    const run = await runCli(['deploy', 'production', '--yes', '--infra', '../checkout/infra'], {
      cwd,
      homeDir: '/home/owner',
    });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(deployedWith().infraDirectory).toBe(path.resolve(cwd, '../checkout/infra'));
    expect(deployedWith().projectDirectory).toBe(cwd);
  });

  it('lists every deploy target when the project has no production environment (#796)', async () => {
    const cwd = await project(PROJECT.replace(/ {2}production:\n.*\n.*\n/u, ''));

    const run = await runCli(['deploy', 'production'], { cwd, homeDir: '/home/owner' });

    expect(run.stderr).toContain('single-vm | gcp-cloudrun | kubernetes | vercel');
    expect(deployProjectEnvironment).not.toHaveBeenCalled();
  });

  it('passes no infra directory when --infra is not given', async () => {
    deployProjectEnvironment.mockResolvedValue(outcome(false, false));

    await runCli(['deploy', 'production'], { cwd: await project() });

    expect(deployedWith()).not.toHaveProperty('infraDirectory');
  });

  it('exits 0 for a plan with no changes', async () => {
    deployProjectEnvironment.mockResolvedValue(outcome(false, false));

    const run = await runCli(['deploy', 'production', '--plan'], { cwd: await project() });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(EXIT_CODE.ok);
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
      PROJECT.replace(/ {2}production:\n.*\n.*\n/u, ''),
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
    const cwd = await tempDirectory();
    temporary.push(cwd);

    const run = await runCli(['deploy', 'production'], { cwd });

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('no agent-workspace.yaml in this directory');
  });

  it("reports a deploy step's refusal as a refused request", async () => {
    deployProjectEnvironment.mockRejectedValue(new Error('Node.js 24 or later is required'));

    const run = await runCli(['deploy', 'production'], { cwd: await project() });

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toBe('error: Node.js 24 or later is required\n');
  });
});
