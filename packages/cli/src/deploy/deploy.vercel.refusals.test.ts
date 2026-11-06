import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runDeployCommand } from './command.js';
import type { ToolRunner } from './runner.js';
import {
  captured,
  capturedFailure,
  project,
  stubRunner,
  temporaryDirectory,
} from './deploy.test-support.js';
import {
  changesOf,
  manifest,
  platform,
  setEnv,
  token,
  vcrImage,
  vercelEnvironment,
  vercelProject,
  vercelResponder,
} from './deploy.vercel.test-support.js';

function checkoutRefusals(): void {
  it('refuses a platform checkout without the gateway function entry, before any tool runs', async () => {
    const target = await vercelProject();
    const source = mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-platform-copy-'));
    await cp(platform, source, { recursive: true });
    await rm(path.join(source, 'packages', 'gateway', 'src', 'api'), { recursive: true });
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: { ...vercelEnvironment, AGENT_WORKSPACE_SOURCE: source },
      }),
    );
    await rm(source, { recursive: true, force: true });

    expect(message).toContain(path.join('packages', 'gateway', 'src', 'api', 'index.ts'));
    expect(message).toContain('Nothing was run');
    expect(calls).toEqual([]);
  });

  it('refuses an AGENT_WORKSPACE_SOURCE that is not a platform checkout, before any tool runs', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: { ...vercelEnvironment, AGENT_WORKSPACE_SOURCE: path.join(platform, 'typo') },
      }),
    );

    expect(message).toContain('AGENT_WORKSPACE_SOURCE');
    expect(message).toContain('no apps/web directory');
    expect(message).toContain('Nothing was run');
    expect(calls).toEqual([]);
  });

  it('refuses a part the checkout cannot stage, before any tool runs', async () => {
    const target = await vercelProject();
    const source = await temporaryDirectory();
    await cp(platform, source, { recursive: true });
    await writeFile(
      path.join(source, 'apps', 'runner', 'package.json'),
      manifest('runner', { '@agent-workspace/missing': 'workspace:*' }),
    );
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: { ...vercelEnvironment, AGENT_WORKSPACE_SOURCE: source },
      }),
    );

    expect(message).toContain('@agent-workspace/missing');
    expect(message).toContain('Nothing was run');
    expect(calls).toEqual([]);
  });
}

function missingInputRefusals(): void {
  it.each([
    ['AGENT_WORKSPACE_SOURCE', { VERCEL_TOKEN: token, VERCEL_TEAM_ID: 'team_acme' }, true],
    ['DATABASE_URL', vercelEnvironment, false],
  ])('refuses an apply without %s by name, before any tool runs', async (name, env, hasUrl) => {
    const target = hasUrl ? await vercelProject() : await project('vercel');
    await setEnv(target, 'VERCEL_SANDBOX_RUNTIME_IMAGE', vcrImage);
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: env }),
    );

    expect(message).toContain(name);
    expect(message).toContain('Nothing was run');
    expect(calls).toEqual([]);
  });

  it('names the Neon integration only when DATABASE_URL is the empty value', async () => {
    const target = await vercelProject();
    const file = path.join(target, '.env');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace(/\nBOOTSTRAP_ADMIN=[^\n]*\n/u, '\nBOOTSTRAP_ADMIN=\n'));
    const { runner } = stubRunner(vercelResponder(false));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(message).toContain('BOOTSTRAP_ADMIN is empty');
    expect(message).not.toContain('Neon');
  });
}

function inspectFailureCases(): void {
  it('creates a project the current Vercel CLI reports as having no project, with --scope only', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(({ args }) =>
      args[1] === 'inspect'
        ? {
            status: 1,
            stderr:
              'WARNING! The "--team" option is deprecated. Please use "--scope" instead.\n' +
              `Error: There is no project for "${args[2] ?? ''}"\n`,
          }
        : {},
    );

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(calls.filter(({ args }) => args[0] === 'project' && args[1] === 'add')).toHaveLength(3);
    const vercelArgs = calls.filter(({ tool }) => tool === 'vercel').flatMap(({ args }) => args);
    expect(vercelArgs).toContain('--scope');
    expect(vercelArgs).not.toContain('--team');
  });

  it('does not take a failed inspect for a missing project, and redacts what it reports', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(() => ({
      status: 1,
      stderr: `Error: The specified token is not valid ${token}`,
    }));

    const { message, output } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(message).toContain('did not say the project is missing');
    expect(`${message}${output}`).not.toContain(token);
    expect(changesOf(calls)).toEqual([]);
    expect(calls.some(({ args }) => args[0] === 'project' && args[1] === 'add')).toBe(false);
  });
}

function targetAndToolRefusals(): void {
  it('refuses --target helm for a Vercel profile and --target vercel for another cloud', async () => {
    const vercel = await project('vercel');
    const gcp = await project('gcp');
    const { runner, calls } = stubRunner(() => ({}));

    const helm = await capturedFailure(() =>
      runDeployCommand([vercel, '--target', 'helm'], { runner, environment: vercelEnvironment }),
    );
    const other = await capturedFailure(() =>
      runDeployCommand([gcp, '--target', 'vercel'], { runner, environment: vercelEnvironment }),
    );

    expect(helm.message).toContain('does not apply to cloud "vercel"');
    expect(other.message).toContain('--target vercel does not apply to cloud "gcp"');
    expect(calls).toEqual([]);
  });

  it('names agent-workspace doctor when the vercel CLI is not installed', async () => {
    const target = await project('vercel');
    const runner: ToolRunner = () =>
      Promise.reject(Object.assign(new Error('spawn vercel ENOENT'), { code: 'ENOENT' }));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target], { runner, environment: vercelEnvironment }),
    );

    expect(message).toContain('vercel is not installed or not on PATH');
    expect(message).toContain('agent-workspace doctor');
  });
}

describe('agent-workspace deploy to Vercel', () => {
  checkoutRefusals();
  missingInputRefusals();
  inspectFailureCases();
  targetAndToolRefusals();
});
