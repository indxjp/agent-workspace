import type { DeployStatusReport } from '@indx-workspace/cli/deploy';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { runCli } from '../testing.js';

import { PRODUCTION_STATE_DIRECTORY, project, resetDeployFixtures } from './deploy.test-support.js';
import { deployMocks } from './deploy.mocks.test-support.js';

vi.mock(
  '@indx-workspace/cli/deploy',
  async () => (await import('./deploy.mocks.test-support.js')).deployMocks,
);

const { destroyProjectEnvironment, deployStatus } = deployMocks;

afterEach(resetDeployFixtures);

describe('aw deploy destroy production', () => {
  it('reads the typed project id from one line of standard input when not interactive', async () => {
    let typed = '';
    destroyProjectEnvironment.mockImplementation(async (options) => {
      typed = await options.confirm('Type the Google Cloud project id to delete everything');
    });

    const run = await runCli(['deploy', 'destroy', 'production'], {
      cwd: await project(),
      homeDir: '/home/owner',
      stdin: 'acme-prod\nignored\n',
    });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(typed).toBe('acme-prod');
    expect(destroyProjectEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'production' }),
    );
  });

  it('asks at the terminal when interactive', async () => {
    const questions: string[] = [];
    destroyProjectEnvironment.mockImplementation(async (options) => {
      await options.confirm('Type the Google Cloud project id to delete everything');
    });

    await runCli(['deploy', 'destroy', 'production'], {
      cwd: await project(),
      isTty: true,
      prompt: (question) => {
        questions.push(question);
        return Promise.resolve('acme-prod');
      },
    });

    expect(questions).toEqual(['Type the Google Cloud project id to delete everything: ']);
  });

  it('refuses what the CLI refuses, as a problem', async () => {
    destroyProjectEnvironment.mockRejectedValue(
      new Error('"acme" is not the project id. Nothing was destroyed.'),
    );

    const run = await runCli(['deploy', 'destroy', 'production'], {
      cwd: await project(),
      stdin: 'acme\n',
    });

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('Nothing was destroyed.');
  });

  it('takes production only', async () => {
    const run = await runCli(['deploy', 'destroy', 'staging'], { cwd: await project() });

    expect(run.code).toBe(EXIT_CODE.usage);
    expect(destroyProjectEnvironment).not.toHaveBeenCalled();
  });
});

describe('aw deploy status production', () => {
  const report = (overrides: Partial<DeployStatusReport> = {}): DeployStatusReport => ({
    text: 'Drift: none\n',
    ready: true,
    changes: false,
    ...overrides,
  });

  it('prints the report and exits 0 when every service is ready and the plan is empty', async () => {
    deployStatus.mockResolvedValue(report());

    const run = await runCli(['deploy', 'status', 'production'], {
      cwd: await project(),
      homeDir: '/home/owner',
    });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain('Drift: none');
    expect(deployStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'production',
        stateDirectory: PRODUCTION_STATE_DIRECTORY,
      }),
    );
  });

  it('exits 3 when the plan has changes', async () => {
    deployStatus.mockResolvedValue(report({ text: 'Drift: 2 change(s)\n', changes: true }));

    const run = await runCli(['deploy', 'status', 'production'], { cwd: await project() });

    expect(run.code).toBe(EXIT_CODE.contract);
    expect(run.stdout).toContain('Drift: 2 change(s)');
  });

  it('refuses when a service is not ready, even with an empty plan', async () => {
    deployStatus.mockResolvedValue(report({ ready: false }));

    const run = await runCli(['deploy', 'status', 'production'], { cwd: await project() });

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('a service is not ready');
  });

  it('refuses what the CLI refuses, as a problem', async () => {
    deployStatus.mockRejectedValue(new Error('Nothing was deployed from this machine.'));

    const run = await runCli(['deploy', 'status', 'production'], { cwd: await project() });

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('Nothing was deployed from this machine.');
  });

  it('takes production only', async () => {
    const run = await runCli(['deploy', 'status', 'staging'], { cwd: await project() });

    expect(run.code).toBe(EXIT_CODE.usage);
    expect(deployStatus).not.toHaveBeenCalled();
  });

  it('takes no extra argument', async () => {
    const run = await runCli(['deploy', 'status', 'production', 'now'], {
      cwd: await project(),
    });

    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('unexpected argument');
    expect(deployStatus).not.toHaveBeenCalled();
  });
});
