import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { parseEnvironment } from '../deployment.js';
import { runDeployCommand } from './command.js';
import type { ToolRunner } from './runner.js';
import {
  captured,
  capturedFailure,
  composeResponder,
  environment,
  helmResponder,
  infra,
  isApply,
  project,
  stubRunner,
  temporaryDirectory,
  terraformResponder,
} from './deploy.test-support.js';

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

function terraformApplyCases(): void {
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
}

function terraformApplyEdgeCases(): void {
  it('applies a plan with changes that a wrapper reported with exit status 0', async () => {
    // setup-terraform's terraform_wrapper exits 0 for Terraform's 2; the plan file decides.
    const target = await project('azure');
    const infraDirectory = await infra();
    const { runner, calls } = stubRunner(terraformResponder(true, '', 0));

    const { result } = await captured(async () =>
      runDeployCommand([target, '--yes', '--infra', infraDirectory], { runner, environment }),
    );

    expect(result).toEqual({ changes: true, applied: true });
    expect(calls.filter(isApply)).toHaveLength(1);
  });

  it('refuses, applying nothing, when the plan file of an exit-0 plan cannot be read', async () => {
    const target = await project('azure');
    const infraDirectory = await infra();
    const { runner, calls } = stubRunner((invocation) =>
      invocation.args.includes('show')
        ? { stdout: 'not json' }
        : terraformResponder(false)(invocation),
    );

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes', '--infra', infraDirectory], { runner, environment }),
    );

    expect(message).toContain('`terraform show -json` did not print a plan. Nothing was applied.');
    expect(calls.filter(isApply)).toEqual([]);
  });
}

function composeAndHelmApplyCases(): void {
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
}

function composeProjectNameCase(): void {
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
}

describe('agent-workspace deploy --yes', () => {
  terraformApplyCases();
  terraformApplyEdgeCases();
  composeAndHelmApplyCases();
  composeProjectNameCase();
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
          return { status: 2, stdout: '', stderr: '' };
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

function refusedBeforeAnyTool(): void {
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
}

function failedPlan(): void {
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
}

describe('agent-workspace deploy refusals', () => {
  refusedBeforeAnyTool();
  failedPlan();
});
