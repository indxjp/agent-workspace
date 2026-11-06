import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runDeployCommand } from './command.js';
import type { ToolRunner } from './runner.js';
import {
  captured,
  capturedFailure,
  project,
  runtimeImageKey,
  stubRunner,
  toolHostTemplate,
} from './deploy.test-support.js';
import {
  appendEnv,
  bulkFor,
  cloudflareEnvironment,
  cloudflareProject,
  cloudflareResponder,
  controlPlanePuts,
  e2bTemplate,
  editEnv,
  retentionPuts,
  selectExternalRuntime,
  token,
} from './deploy.cloudflare.test-support.js';

function missingValueRefusals(): void {
  it.each(['DATABASE_URL', 'BOOTSTRAP_ADMIN'])(
    'refuses an apply whose .env has no %s, by name, before any tool runs',
    async (name) => {
      const target = await cloudflareProject();
      await editEnv(target, name, '');
      const { runner, calls } = stubRunner(() => ({}));

      const { message } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
      );

      expect(message).toContain(`${name} is empty in .env`);
      expect(calls).toEqual([]);
    },
  );

  it.each([
    ['RUNNER_MANAGER_TOKEN', '', 'RUNNER_MANAGER_TOKEN is empty in .env'],
    ['GATEWAY_TOKEN_SECRET', '', 'GATEWAY_TOKEN_SECRET is empty in .env'],
    [
      'CLOUDFLARE_SANDBOX_BRIDGE_URL',
      'http://acme-ai-bridge.acme.workers.dev',
      'CLOUDFLARE_SANDBOX_BRIDGE_URL must be an https URL',
    ],
    [
      'CLOUDFLARE_SANDBOX_BRIDGE_URL',
      'https://',
      'CLOUDFLARE_SANDBOX_BRIDGE_URL must be an https URL',
    ],
  ])(
    'refuses an apply whose .env has %s=%j, by name, before any tool runs',
    async (name, value, refusal) => {
      const target = await cloudflareProject();
      await editEnv(target, name, value);
      const { runner, calls } = stubRunner(() => ({}));

      const { message } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
      );

      expect(message).toContain(refusal);
      expect(message).toContain('Nothing was run');
      expect(calls).toEqual([]);
    },
  );
}

function imagePinAndBridgeCases(): void {
  it.each([
    ['WEB_IMAGE', 'web', 'ghcr.io/acme/web:latest'],
    ['GATEWAY_IMAGE', 'gateway', 'ghcr.io/acme/gateway@sha256:abc'],
    ['RUNNER_IMAGE', 'runner', 'ghcr.io/acme/runner'],
  ])(
    'refuses an image that is not pinned by digest in %s, by name',
    async (name, service, image) => {
      const target = await cloudflareProject();
      await editEnv(target, name, image);
      const { runner, calls } = stubRunner(() => ({}));

      const { message } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
      );

      expect(message).toContain(`the pinned ${service} image must be a non-placeholder sha256`);
      expect(calls).toEqual([]);
    },
  );

  it('requires the sandbox bridge URL for cloudflare-sandbox but not for external', async () => {
    const target = await cloudflareProject();
    await editEnv(target, 'CLOUDFLARE_SANDBOX_BRIDGE_URL', '');
    const refused = stubRunner(() => ({}));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner: refused.runner,
        environment: cloudflareEnvironment,
      }),
    );
    expect(message).toContain('CLOUDFLARE_SANDBOX_BRIDGE_URL is empty in .env');
    expect(refused.calls).toEqual([]);

    // The profile selects E2B; `.env` still says cloudflare-sandbox, which `render` leaves alone.
    await selectExternalRuntime(target);
    await appendEnv(target, 'E2B_RUNTIME_TEMPLATE', e2bTemplate);
    const { respond } = cloudflareResponder(true);
    const accepted = stubRunner(respond);
    const { result } = await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner: accepted.runner,
        environment: cloudflareEnvironment,
      }),
    );
    expect(result).toEqual({ changes: true, applied: true });
    const manager = bulkFor(accepted.calls, 'acme-ai-manager');
    expect(manager['RUNTIME_DRIVER']).toBe('external');
    expect(manager['EXTERNAL_PROVIDER']).toBe('e2b');
    expect(manager).not.toHaveProperty('CLOUDFLARE_SANDBOX_BRIDGE_URL');
  });
}

function externalRuntimeRefusals(): void {
  it('refuses an external runtime that is not an E2B template pinned by build id, before any tool runs', async () => {
    const target = await cloudflareProject();
    await selectExternalRuntime(target);
    const { runner, calls } = stubRunner(() => ({}));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(message).toContain('E2B_RUNTIME_TEMPLATE must be an E2B template pinned as');
    expect(message).toContain('Nothing was run');
    expect(calls).toEqual([]);
  });

  it('refuses an external runtime whose tool-host template is not pinned by build id, by name (#827)', async () => {
    const target = await cloudflareProject();
    await selectExternalRuntime(target);
    await appendEnv(target, 'E2B_RUNTIME_TEMPLATE', e2bTemplate);
    await appendEnv(target, 'E2B_TOOL_HOST_TEMPLATE', 'aw-tool-host');
    const { runner, calls } = stubRunner(() => ({}));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(message).toContain('E2B_TOOL_HOST_TEMPLATE must be an E2B template pinned as');
    expect(message).toContain('Nothing was run');
    expect(calls).toEqual([]);
  });
}

function toolHostCase(): void {
  it('renders the tool-host flag to the manager and control plane for an external runtime only (#827)', async () => {
    const target = await cloudflareProject();
    await appendEnv(target, 'E2B_TOOL_HOST_TEMPLATE', toolHostTemplate);
    const sandbox = stubRunner(cloudflareResponder(true).respond);
    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner: sandbox.runner,
        environment: cloudflareEnvironment,
      }),
    );
    for (const worker of ['acme-ai-manager', 'acme-ai-control-plane']) {
      const secrets = bulkFor(sandbox.calls, worker);
      expect(secrets, worker).not.toHaveProperty('AGENT_WORKSPACE_TOOL_HOST_IMAGE');
      expect(secrets, worker).not.toHaveProperty('E2B_TOOL_HOST_TEMPLATE');
    }
    expect(bulkFor(sandbox.calls, 'acme-ai-gateway')).not.toHaveProperty('RUNNER_MANAGER_TOKEN');

    await selectExternalRuntime(target);
    await appendEnv(target, 'E2B_RUNTIME_TEMPLATE', e2bTemplate);
    const external = stubRunner(cloudflareResponder(true).respond);
    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner: external.runner,
        environment: cloudflareEnvironment,
      }),
    );
    for (const worker of ['acme-ai-manager', 'acme-ai-control-plane']) {
      const secrets = bulkFor(external.calls, worker);
      expect(secrets['AGENT_WORKSPACE_TOOL_HOST_IMAGE'], worker).toBe(toolHostTemplate);
      expect(secrets, worker).not.toHaveProperty('E2B_TOOL_HOST_TEMPLATE');
    }
    expect(bulkFor(external.calls, 'acme-ai-gateway')['RUNNER_MANAGER_TOKEN']).toBe(
      bulkFor(external.calls, 'acme-ai-manager')['RUNNER_MANAGER_TOKEN'],
    );
  });
}

function statelessAndDomainCases(): void {
  it('runs an external (E2B) manager stateless, and a cloudflare-sandbox one not', async () => {
    const target = await cloudflareProject();
    const sandbox = stubRunner(cloudflareResponder(true).respond);
    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner: sandbox.runner,
        environment: cloudflareEnvironment,
      }),
    );
    expect(bulkFor(sandbox.calls, 'acme-ai-manager')).not.toHaveProperty(
      'RUNNER_MANAGER_STATELESS',
    );

    await selectExternalRuntime(target);
    await appendEnv(target, 'E2B_RUNTIME_TEMPLATE', e2bTemplate);
    const external = stubRunner(cloudflareResponder(true).respond);
    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner: external.runner,
        environment: cloudflareEnvironment,
      }),
    );
    const externalManager = bulkFor(external.calls, 'acme-ai-manager');
    expect(externalManager['RUNNER_MANAGER_STATELESS']).toBe('true');
    expect(externalManager[runtimeImageKey]).toBe(e2bTemplate);
    expect(bulkFor(external.calls, 'acme-ai-control-plane')).not.toHaveProperty(
      'E2B_RUNTIME_TEMPLATE',
    );
  });

  it('uses a custom domain from .env for the gateway and manager instead of workers.dev', async () => {
    const target = await cloudflareProject();
    const file = path.join(target, '.env');
    await writeFile(
      file,
      `${await readFile(file, 'utf8')}MODEL_GATEWAY_URL=https://gateway.example.com\nRUNNER_MANAGER_URL=https://manager.example.com\n`,
    );
    const { runner, calls } = stubRunner(cloudflareResponder(true).respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(controlPlanePuts(calls)).toContainEqual([
      'MODEL_GATEWAY_URL',
      'https://gateway.example.com',
    ]);
    expect(controlPlanePuts(calls)).toContainEqual([
      'RUNNER_MANAGER_URL',
      'https://manager.example.com',
    ]);
    expect(bulkFor(calls, 'acme-ai-manager')['GATEWAY_PUBLIC_URL']).toBe(
      'https://gateway.example.com',
    );
  });
}

function tokenAndRotationCases(): void {
  it('puts a rotated secret over the existing one on every apply and never prints it', async () => {
    const target = await cloudflareProject();
    const rotated = 'f'.repeat(64);
    await editEnv(target, 'CRON_SECRET', rotated);
    await editEnv(target, 'MASTER_ENCRYPTION_KEY', rotated);
    const { respond } = cloudflareResponder(true, { listed: ['CONTROL_PLANE_URL', 'CRON_SECRET'] });
    const { runner, calls } = stubRunner(respond);

    const { result, output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(result).toEqual({ changes: true, applied: true });
    const deployed = calls.filter(({ args }) => args[0] === 'deploy').map(({ args }) => args[4]);
    expect(deployed).toEqual(['acme-ai-gateway', 'acme-ai-manager', 'acme-ai-control-plane']);
    expect(retentionPuts(calls)).toContainEqual(['CRON_SECRET', rotated]);
    expect(controlPlanePuts(calls)).toContainEqual(['MASTER_ENCRYPTION_KEY', rotated]);
    expect(bulkFor(calls, 'acme-ai-gateway')['MASTER_ENCRYPTION_KEY']).toBe(rotated);
    expect(retentionPuts(calls).map(([name]) => name)).not.toContain('MASTER_ENCRYPTION_KEY');
    expect(output).not.toContain(rotated);
    for (const call of calls) expect(call.args.join(' ')).not.toContain(rotated);
  });

  it('hands the token to the tool through its environment and never prints it', async () => {
    const target = await cloudflareProject();
    const { respond } = cloudflareResponder(false, { echo: token });
    const { runner, calls } = stubRunner(respond);

    const { output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    const wrangler = calls.filter(({ tool }) => tool === 'wrangler');
    expect(wrangler.length).toBeGreaterThan(5);
    expect(wrangler.every((call) => call.env['CLOUDFLARE_API_TOKEN'] === token)).toBe(true);
    expect(wrangler.every((call) => call.env['CLOUDFLARE_ACCOUNT_ID'] === 'acct123')).toBe(true);
    expect(calls.every((call) => !call.args.join(' ').includes(token))).toBe(true);
    expect(output).not.toContain(token);
  });

  it('does not take a failed secret list for a missing Worker, and redacts what it reports', async () => {
    const target = await cloudflareProject();
    const { runner, calls } = stubRunner(() => ({
      status: 1,
      stderr: `Authentication error [code: 10000] ${token}`,
    }));

    const { message, output } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(message).toContain('did not say the Worker is missing');
    expect(`${message}${output}`).not.toContain(token);
    expect(calls).toHaveLength(1);
  });
}

function targetAndToolRefusals(): void {
  it('refuses --target helm for a Cloudflare profile and --target cloudflare for another cloud', async () => {
    const cloudflare = await project('cloudflare');
    const gcp = await project('gcp');
    const { runner, calls } = stubRunner(() => ({}));

    const helm = await capturedFailure(() =>
      runDeployCommand([cloudflare, '--target', 'helm'], {
        runner,
        environment: cloudflareEnvironment,
      }),
    );
    const other = await capturedFailure(() =>
      runDeployCommand([gcp, '--target', 'cloudflare'], {
        runner,
        environment: cloudflareEnvironment,
      }),
    );

    expect(helm.message).toContain('does not apply to cloud "cloudflare"');
    expect(other.message).toContain('--target cloudflare does not apply to cloud "gcp"');
    expect(calls).toEqual([]);
  });

  it('names agent-workspace doctor when wrangler is not installed', async () => {
    const target = await project('cloudflare');
    const runner: ToolRunner = () =>
      Promise.reject(Object.assign(new Error('spawn wrangler ENOENT'), { code: 'ENOENT' }));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target], { runner, environment: cloudflareEnvironment }),
    );

    expect(message).toContain('wrangler is not installed or not on PATH');
    expect(message).toContain('agent-workspace doctor');
  });
}

describe('agent-workspace deploy to Cloudflare', () => {
  missingValueRefusals();
  imagePinAndBridgeCases();
  externalRuntimeRefusals();
  toolHostCase();
  statelessAndDomainCases();
  tokenAndRotationCases();
  targetAndToolRefusals();
});
