import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { runCli } from '../testing.js';

import {
  PRODUCTION_STATE_DIRECTORY,
  PROJECT,
  deployedWith,
  outcome,
  project,
  resetDeployFixtures,
} from './deploy.test-support.js';
import { deployMocks } from './deploy.mocks.test-support.js';

vi.mock(
  '@indx-workspace/cli/deploy',
  async () => (await import('./deploy.mocks.test-support.js')).deployMocks,
);

const { deployProjectEnvironment, showOwnerPassword } = deployMocks;

afterEach(resetDeployFixtures);

describe('aw deploy (#621)', () => {
  it('says nothing was applied when --yes stopped after the image copy', async () => {
    deployProjectEnvironment.mockResolvedValue(outcome(true, false));
    const cwd = await project();

    const run = await runCli(['deploy', 'production', '--yes'], { cwd, homeDir: '/home/owner' });

    expect(run.code).toBe(EXIT_CODE.contract);
    expect(run.stderr).toBe(
      'error: nothing was applied; run --plan to review the changes, then --yes\n',
    );
  });

  it('hands the deploy a hidden-input prompt only at a terminal', async () => {
    deployProjectEnvironment.mockResolvedValue(outcome(false, true));
    const asked: string[] = [];
    const promptSecret = (question: string) => {
      asked.push(question);
      return Promise.resolve('s3cret');
    };

    await runCli(['deploy', 'production', '--yes'], {
      cwd: await project(),
      homeDir: '/home/owner',
      isTty: true,
      promptSecret,
    });
    const answer = await deployedWith().readSecret?.('Sign-in client secret');
    expect(answer).toBe('s3cret');
    expect(asked).toEqual(['Sign-in client secret: ']);

    deployProjectEnvironment.mockClear();
    await runCli(['deploy', 'production', '--yes'], {
      cwd: await project(),
      homeDir: '/home/owner',
      promptSecret,
    });
    expect(deployedWith().readSecret).toBeUndefined();
  });

  it('plans by default, into the state directory, and exits 3 when changes are pending', async () => {
    deployProjectEnvironment.mockResolvedValue(outcome(true, false));
    const cwd = await project();

    const run = await runCli(['deploy', 'production'], { cwd, homeDir: '/home/owner' });

    expect(run.code).toBe(EXIT_CODE.contract);
    expect(run.stderr).toBe('error: changes are pending; re-run with --yes to apply them\n');
    expect(deployedWith()).toMatchObject({
      environment: 'production',
      apply: false,
      stateDirectory: PRODUCTION_STATE_DIRECTORY,
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
      `deployed production from ${PRODUCTION_STATE_DIRECTORY}\nnext: a\nnext: b\n`,
    );
  });

  it('does not send --yes back to --plan: a Cloud Run deploy copies the images and applies in one run', async () => {
    deployProjectEnvironment.mockResolvedValue(outcome(true, true));

    const run = await runCli(['deploy', 'production', '--yes'], {
      cwd: await project(),
      homeDir: '/home/owner',
    });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stderr).not.toContain('run --plan');
  });

  it('prints only the Owner password for --show-owner-password, and deploys nothing', async () => {
    showOwnerPassword.mockResolvedValue('S3cretPassw0rd');

    const run = await runCli(['deploy', 'production', '--show-owner-password'], {
      cwd: await project(),
      homeDir: '/home/owner',
    });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe('S3cretPassw0rd\n');
    expect(deployProjectEnvironment).not.toHaveBeenCalled();
  });

  it('refuses --show-owner-password beside --yes', async () => {
    const run = await runCli(['deploy', 'production', '--show-owner-password', '--yes'], {
      cwd: await project(),
    });

    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--show-owner-password stands alone');
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

  it("reports a deploy step's refusal as a refused request", async () => {
    deployProjectEnvironment.mockRejectedValue(new Error('Node.js 24 or later is required'));

    const run = await runCli(['deploy', 'production'], { cwd: await project() });

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toBe('error: Node.js 24 or later is required\n');
  });
});
