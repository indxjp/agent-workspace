import { rm } from 'node:fs/promises';
import path from 'node:path';

import type {
  DeployProjectEnvironmentOptions,
  DeployStatusOptions,
  DeployStatusReport,
  DestroyProjectEnvironmentOptions,
  ProjectDeployOutcome,
  ShowOwnerPasswordOptions,
} from '@indx-workspace/cli/deploy';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { runCli, tempDirectory, tempFile } from '../testing.js';

const deployProjectEnvironment = vi.hoisted(() =>
  vi.fn<(options: DeployProjectEnvironmentOptions) => Promise<ProjectDeployOutcome>>(),
);
const showOwnerPassword = vi.hoisted(() =>
  vi.fn<(options: ShowOwnerPasswordOptions) => Promise<string>>(),
);
const destroyProjectEnvironment = vi.hoisted(() =>
  vi.fn<(options: DestroyProjectEnvironmentOptions) => Promise<void>>(),
);
const deployStatus = vi.hoisted(() =>
  vi.fn<(options: DeployStatusOptions) => Promise<DeployStatusReport>>(),
);
vi.mock('@indx-workspace/cli/deploy', () => ({
  deployStatus,
  deployProjectEnvironment,
  showOwnerPassword,
  destroyProjectEnvironment,
}));

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
  showOwnerPassword.mockReset();
  destroyProjectEnvironment.mockReset();
  deployStatus.mockReset();
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

  describe('destroy production', () => {
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

  describe('status production', () => {
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
          stateDirectory: path.join(
            '/home/owner',
            '.config',
            'agent-workspace',
            'deployments',
            'acme-ai',
            'production',
          ),
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

    it('refuses an app in aw-generated.json missing from environments.production.apps', async () => {
      const cwd = await project();
      await tempFile(cwd, 'aw-generated.json', MANIFEST);

      const run = await runCli(['deploy', 'production'], { cwd, homeDir: '/home/owner' });

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

      const run = await runCli(['deploy', 'production'], { cwd, homeDir: '/home/owner' });

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

      const run = await runCli(['deploy', 'production'], { cwd, homeDir: '/home/owner' });

      expect(run.code).toBe(EXIT_CODE.usage);
      expect(run.stderr).toContain('aw-generated.json');
      expect(deployProjectEnvironment).not.toHaveBeenCalled();
    });
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
