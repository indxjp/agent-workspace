import { describe, expect, it } from 'vitest';

import { runDeployCommand } from './command.js';
import { captured, capturedFailure, project, stubRunner } from './deploy.test-support.js';
import {
  changesOf,
  token,
  vercelEnvironment,
  vercelProject,
  vercelResponder,
} from './deploy.vercel.test-support.js';

function refusedCredentials(): void {
  it.each([
    ['VERCEL_TOKEN', { VERCEL_TEAM_ID: 'team_acme' }],
    ['VERCEL_TOKEN', { VERCEL_TOKEN: '  ', VERCEL_TEAM_ID: 'team_acme' }],
    ['VERCEL_TEAM_ID', { VERCEL_TOKEN: token }],
  ])('refuses a missing %s by name and runs no tool', async (name, missing) => {
    const target = await project('vercel');
    const { runner, calls } = stubRunner(() => ({}));

    const { message, output } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: missing }),
    );

    expect(message).toContain(`${name} is not set`);
    expect(message).toContain('Nothing was run');
    expect(`${message}${output}`).not.toContain(token);
    expect(calls).toEqual([]);
  });
}

function offlinePlan(): void {
  it('plans offline without the token or team id, running no tool (BH061-027)', async () => {
    const target = await project('vercel');
    const { runner, calls } = stubRunner(() => ({}));

    const { result, output } = await captured(() =>
      runDeployCommand([target], { runner, environment: {} }),
    );

    expect(result).toEqual({ changes: true, applied: false });
    expect(calls).toEqual([]);
    expect(output).toContain(`Planning ${target}`);
    expect(output).not.toContain('Deploying');
    expect(output).toContain('VERCEL_TOKEN and VERCEL_TEAM_ID are not set');
    expect(output).toMatch(/Vercel project acme-ai-gateway \(gateway\): \d+ production variable/u);
    expect(output).toContain('Vercel project acme-ai (control plane)');
  });

  it('needs neither the platform checkout nor DATABASE_URL to plan', async () => {
    const target = await project('vercel');
    const { runner } = stubRunner(vercelResponder(true));

    const { result } = await captured(() =>
      runDeployCommand([target], {
        runner,
        environment: { VERCEL_TOKEN: token, VERCEL_TEAM_ID: 'team_acme' },
      }),
    );

    expect(result).toEqual({ changes: true, applied: false });
  });
}

function listedPlan(): void {
  it('lists the missing variables and changes nothing without --yes', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(vercelResponder(true, ['SESSION_SECRET']));

    const { result, output } = await captured(() =>
      runDeployCommand([target], { runner, environment: vercelEnvironment }),
    );

    expect(result).toEqual({ changes: true, applied: false });
    expect(output).toContain('MASTER_ENCRYPTION_KEY');
    expect(output).toContain('CRON_SECRET');
    expect(output).not.toContain('SESSION_SECRET,');
    expect(output).toContain('Re-run with --yes');
    expect(changesOf(calls)).toEqual([]);
    // An inspect and a listing for each of the gateway, the manager and the control plane.
    expect(calls.map(({ args }) => `${args[0] ?? ''} ${args[1] ?? ''}`)).toEqual([
      'project inspect',
      'env ls',
      'project inspect',
      'env ls',
      'project inspect',
      'env ls',
    ]);
    expect(calls.map(({ env }) => env['VERCEL_PROJECT_ID'])).toEqual([
      undefined,
      'acme-ai-gateway',
      undefined,
      'acme-ai-manager',
      undefined,
      'acme-ai',
    ]);
  });
}

function planRunsNothing(): void {
  it('runs no Root Directory request for a plan', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(vercelResponder(true));

    const { output } = await captured(() =>
      runDeployCommand([target], { runner, environment: vercelEnvironment }),
    );

    expect(calls.some(({ args }) => args[0] === 'api')).toBe(false);
    expect(output).toContain('Root Directory of acme-ai will be set to apps/web.');
  });

  it('runs neither the migration nor vercel deploy for a plan', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(vercelResponder(true));

    await captured(() => runDeployCommand([target], { runner, environment: vercelEnvironment }));

    expect(calls.some(({ tool }) => tool === 'docker')).toBe(false);
    expect(calls.some(({ args }) => args[0] === 'deploy')).toBe(false);
  });
}

describe('agent-workspace deploy to Vercel', () => {
  refusedCredentials();
  offlinePlan();
  listedPlan();
  planRunsNothing();
});
