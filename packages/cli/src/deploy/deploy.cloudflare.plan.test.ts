import { describe, expect, it } from 'vitest';

import { runDeployCommand } from './command.js';
import { captured, capturedFailure, project, stubRunner } from './deploy.test-support.js';
import {
  cloudflareEnvironment,
  cloudflareResponder,
  editEnv,
  masterKey,
  putsOf,
  summary,
  token,
} from './deploy.cloudflare.test-support.js';

function missingCredentialCases(): void {
  it.each([
    ['CLOUDFLARE_API_TOKEN', { CLOUDFLARE_ACCOUNT_ID: 'acct123' }],
    ['CLOUDFLARE_API_TOKEN', { CLOUDFLARE_API_TOKEN: '  ', CLOUDFLARE_ACCOUNT_ID: 'acct123' }],
    ['CLOUDFLARE_ACCOUNT_ID', { CLOUDFLARE_API_TOKEN: token }],
    [
      'CLOUDFLARE_WORKERS_SUBDOMAIN',
      { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: 'acct123' },
    ],
    [
      'CONTROL_PLANE_URL',
      {
        CLOUDFLARE_API_TOKEN: token,
        CLOUDFLARE_ACCOUNT_ID: 'acct123',
        CLOUDFLARE_WORKERS_SUBDOMAIN: 'acme',
      },
    ],
  ])('refuses a missing %s by name and runs no tool', async (name, missing) => {
    const target = await project('cloudflare');
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

function addressRefusals(): void {
  it.each(['acme.workers.dev', 'https://acme', '-acme', 'a b'])(
    'refuses the workers.dev subdomain %j, which is not a DNS label',
    async (subdomain) => {
      const target = await project('cloudflare');
      const { runner, calls } = stubRunner(() => ({}));

      const { message } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], {
          runner,
          environment: { ...cloudflareEnvironment, CLOUDFLARE_WORKERS_SUBDOMAIN: subdomain },
        }),
      );

      expect(message).toContain('CLOUDFLARE_WORKERS_SUBDOMAIN must be');
      expect(calls).toEqual([]);
    },
  );

  it('refuses a control plane URL that is not https', async () => {
    const target = await project('cloudflare');
    const { runner, calls } = stubRunner(() => ({}));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: { ...cloudflareEnvironment, CONTROL_PLANE_URL: 'http://app.example.com' },
      }),
    );

    expect(message).toContain('CONTROL_PLANE_URL must be an https:// URL');
    expect(calls).toEqual([]);
  });
}

function offlineAndListedPlans(): void {
  it('plans offline without the token or account id, running no tool (BH061-027)', async () => {
    const target = await project('cloudflare');
    const { runner, calls } = stubRunner(() => ({}));

    const { result, output } = await captured(() =>
      runDeployCommand([target], { runner, environment: { CLOUDFLARE_ACCOUNT_ID: 'acct123' } }),
    );

    expect(result).toEqual({ changes: true, applied: false });
    expect(calls).toEqual([]);
    expect(output).toContain(`Planning ${target}`);
    expect(output).not.toContain('Deploying');
    expect(output).toContain('CLOUDFLARE_API_TOKEN is not set, so this plan reads nothing');
    expect(output).toContain('Cloudflare account acct123');
    expect(output).toContain('https://acme-ai-gateway.<CLOUDFLARE_WORKERS_SUBDOMAIN>.workers.dev');
    expect(output).toContain('Image web');
    expect(output).toContain(': will be created;');
  });

  it('names what it would deploy and put, and changes nothing without --yes', async () => {
    const target = await project('cloudflare');
    const { respond } = cloudflareResponder(true, { listed: ['CRON_SECRET'] });
    const { runner, calls } = stubRunner(respond);

    const { result, output } = await captured(() =>
      runDeployCommand([target], { runner, environment: cloudflareEnvironment }),
    );

    expect(result).toEqual({ changes: true, applied: false });
    expect(output).toContain('CONTROL_PLANE_URL, CRON_SECRET');
    expect(output).toContain('MASTER_ENCRYPTION_KEY');
    expect(output).toContain('AW_STORAGE_URL');
    expect(output).not.toContain(await masterKey(target));
    expect(output).toContain('acme-ai-gateway (https://acme-ai-gateway.acme.workers.dev)');
    expect(output).toContain('acme-ai-manager (https://acme-ai-manager.acme.workers.dev)');
    expect(output).toContain('No frontend Worker');
    expect(output).not.toContain('are not deployed');
    // The read-only registry probe runs in a plan too, and says what an apply would push.
    expect(summary(calls)).toEqual(['wrangler secret list', 'wrangler containers images']);
    expect(output).toContain(`Image web (sha256-${'1'.repeat(64)}): push.`);
    expect(putsOf(calls)).toEqual([]);
  });
}

function registryPlanAndCronRefusal(): void {
  it('says in a plan which images the registry already holds', async () => {
    const target = await project('cloudflare');
    const { respond } = cloudflareResponder(true, { registryTags: `sha256-${'2'.repeat(64)}` });
    const { runner, calls } = stubRunner(respond);

    const { output } = await captured(() =>
      runDeployCommand([target], { runner, environment: cloudflareEnvironment }),
    );

    expect(output).toContain(`Image web (sha256-${'1'.repeat(64)}): push.`);
    expect(output).toContain(
      `Image gateway (sha256-${'2'.repeat(64)}): skip, already in the registry.`,
    );
    expect(calls.some(({ tool }) => tool === 'docker')).toBe(false);
  });

  it('refuses a .env without CRON_SECRET by name and runs no tool', async () => {
    const target = await project('cloudflare');
    await editEnv(target, 'CRON_SECRET', '');
    const { runner, calls } = stubRunner(() => ({}));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(message).toContain('CRON_SECRET is not set');
    expect(calls).toEqual([]);
  });
}

describe('agent-workspace deploy to Cloudflare', () => {
  missingCredentialCases();
  addressRefusals();
  offlineAndListedPlans();
  registryPlanAndCronRefusal();
});
