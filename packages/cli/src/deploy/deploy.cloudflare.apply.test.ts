import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseEnvironment } from '../deployment.js';
import { runDeployCommand } from './command.js';
import type { ToolInvocation } from './runner.js';
import {
  captured,
  capturedFailure,
  databaseUrl,
  digest,
  frontend,
  secretsOf,
  stubRunner,
} from './deploy.test-support.js';
import {
  appendEnv,
  bridgeUrl,
  bulkFor,
  bulksOf,
  cloudflareEnvironment,
  cloudflareProject,
  cloudflareResponder,
  controlPlanePuts,
  editEnv,
  putsOf,
  registry,
  retentionPuts,
  summary,
  token,
} from './deploy.cloudflare.test-support.js';

const fullApplyOrder = [
  'wrangler secret list',
  'wrangler containers images',
  'wrangler r2 bucket',
  'docker pull --platform',
  'docker tag registry.example/web@' + digest('1'),
  'wrangler containers push',
  'docker pull --platform',
  'docker tag registry.example/gateway@' + digest('2'),
  'wrangler containers push',
  'docker pull --platform',
  'docker tag registry.example/runner@' + digest('3'),
  'wrangler containers push',
  'docker run --rm',
  'wrangler deploy --config',
  'wrangler secret bulk',
  'wrangler deploy --config',
  'wrangler secret bulk',
  'wrangler deploy --config',
  'wrangler secret bulk',
  'wrangler deploy --config',
  'wrangler secret put',
  'wrangler secret put',
];

/** Content-addressed: the registry tag is the digest, and `linux/amd64` is the platform pulled. */
function expectImagesPushedByDigest(calls: readonly ToolInvocation[]) {
  expect(calls[3]?.args).toEqual([
    'pull',
    '--platform',
    'linux/amd64',
    `registry.example/web@${digest('1')}`,
  ]);
  expect(calls[4]?.args).toEqual([
    'tag',
    `registry.example/web@${digest('1')}`,
    `agent-workspace-web:sha256-${'1'.repeat(64)}`,
  ]);
  expect(calls.filter(({ args }) => args[1] === 'push').map(({ args }) => args[2])).toEqual([
    `agent-workspace-web:sha256-${'1'.repeat(64)}`,
    `agent-workspace-gateway:sha256-${'2'.repeat(64)}`,
    `agent-workspace-runner:sha256-${'3'.repeat(64)}`,
  ]);
}

/** Each Worker is deployed from a copy that names its registry image; the copy is gone afterwards. */
async function expectWorkersDeployed(
  calls: readonly ToolInvocation[],
  deployed: ReadonlyMap<string, Record<string, unknown>>,
  target: string,
): Promise<ToolInvocation[]> {
  const deploys = calls.filter(({ args }) => args[0] === 'deploy');
  expect(deploys.map(({ args }) => args[4])).toEqual([
    'acme-ai-gateway',
    'acme-ai-manager',
    'acme-ai-control-plane',
    'acme-ai',
  ]);
  const image = (worker: string) => {
    const containers = z
      .array(z.object({ image: z.string() }))
      .parse(deployed.get(worker)?.['containers']);
    return containers[0]?.image;
  };
  expect(image('acme-ai-gateway')).toBe(registry('gateway', '2'));
  expect(image('acme-ai-manager')).toBe(registry('runner', '3'));
  expect(image('acme-ai-control-plane')).toBe(registry('web', '1'));
  expect(deployed.get('acme-ai-gateway')?.['main']).toBe(
    path.join(target, 'deploy', 'cloudflare', 'gateway-worker.mjs'),
  );
  await expect(access(deploys[0]?.args[2] ?? '')).rejects.toThrow();
  expect(deploys[3]?.args).toEqual([
    'deploy',
    '--config',
    path.join(target, 'deploy', 'cloudflare', 'wrangler.jsonc'),
    '--name',
    'acme-ai',
  ]);
  return deploys;
}

/**
 * Every Worker's secrets in one upload: the JSON on stdin, only names in argv, against the same
 * named copy that was deployed (the responder checks the two are equal).
 */
function expectSecretsUploadedOncePerWorker(
  calls: readonly ToolInvocation[],
  deploys: readonly ToolInvocation[],
) {
  expect(bulksOf(calls).map(({ args }) => args.slice(0, 5))).toEqual([
    ['secret', 'bulk', '--name', 'acme-ai-gateway', '--config'],
    ['secret', 'bulk', '--name', 'acme-ai-manager', '--config'],
    ['secret', 'bulk', '--name', 'acme-ai-control-plane', '--config'],
  ]);
  expect(bulksOf(calls).map(({ args }) => args[5])).toEqual(
    deploys.slice(0, 3).map(({ args }) => args[2]),
  );
}

/** The migration runs the web image's own entry, with its values in the child's environment only. */
function expectMigrationInChildEnvironment(calls: readonly ToolInvocation[]) {
  const migration = calls.find(({ args }) => args[0] === 'run');
  expect(migration?.args).toContain(`registry.example/web@${digest('1')}`);
  expect(migration?.args).toContain('DATABASE_URL');
  expect(migration?.env['DATABASE_URL']).toBe(databaseUrl);
  expect(migration?.args.join(' ')).toContain(
    'migrate.js && node /srv/packages/core/dist/db/seed.js',
  );
}

function expectControlPlaneSecrets(
  calls: readonly ToolInvocation[],
  env: Readonly<Record<string, string | undefined>>,
) {
  const controlPlane = controlPlanePuts(calls).map(([name]) => name);
  expect(controlPlanePuts(calls)).toContainEqual([
    'MASTER_ENCRYPTION_KEY',
    env['MASTER_ENCRYPTION_KEY'],
  ]);
  expect(controlPlanePuts(calls)).toContainEqual(['DATABASE_URL', databaseUrl]);
  expect(controlPlanePuts(calls)).toContainEqual([
    'MODEL_GATEWAY_URL',
    'https://acme-ai-gateway.acme.workers.dev',
  ]);
  expect(controlPlanePuts(calls)).toContainEqual([
    'RUNNER_MANAGER_URL',
    'https://acme-ai-manager.acme.workers.dev',
  ]);
  expect(controlPlane).toContain('AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK');
  expect(controlPlane).not.toContain('WEB_IMAGE');
  expect(controlPlane).not.toContain('COMPOSE_PROJECT_NAME');
  expect(controlPlane).not.toContain('AW_FRONTEND_ORIGIN');
  expect(retentionPuts(calls)).toEqual([
    ['CONTROL_PLANE_URL', 'https://app.example.com'],
    ['CRON_SECRET', env['CRON_SECRET']],
  ]);
}

function fullApplyCase(): void {
  it('pushes the images, migrates once, deploys gateway, manager and control plane, then retention', async () => {
    const target = await cloudflareProject();
    const env = parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'));
    const { respond, deployed } = cloudflareResponder(false);
    const { runner, calls } = stubRunner(respond);

    const { result, output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(result).toEqual({ changes: true, applied: true });
    expect(summary(calls)).toEqual(fullApplyOrder);
    expectImagesPushedByDigest(calls);
    const deploys = await expectWorkersDeployed(calls, deployed, target);
    expectSecretsUploadedOncePerWorker(calls, deploys);
    expectMigrationInChildEnvironment(calls);
    expectControlPlaneSecrets(calls, env);
    for (const call of calls) {
      for (const secret of [...(await secretsOf(target)), token]) {
        expect(call.args.join(' ')).not.toContain(secret);
        expect(output).not.toContain(secret);
      }
    }
  });
}

function perWorkerSecretCases(): void {
  it('gives each Worker only the secrets it needs', async () => {
    const target = await cloudflareProject();
    const env = parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'));
    const { respond } = cloudflareResponder(true);
    const { runner, calls } = stubRunner(respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    const gateway = bulkFor(calls, 'acme-ai-gateway');
    expect(gateway['DATABASE_URL']).toBe(databaseUrl);
    expect(gateway['MASTER_ENCRYPTION_KEY']).toBe(env['MASTER_ENCRYPTION_KEY']);
    expect(gateway['GATEWAY_TOKEN_SECRET']).toBe(env['GATEWAY_TOKEN_SECRET']);
    expect(gateway['GATEWAY_CONTROL_PLANE_ORIGIN']).toBe(
      'https://acme-ai-control-plane.acme.workers.dev',
    );

    const manager = bulkFor(calls, 'acme-ai-manager');
    expect(manager).toMatchObject({
      RUNNER_MANAGER_TOKEN: env['RUNNER_MANAGER_TOKEN'],
      RUNTIME_DRIVER: 'cloudflare-sandbox',
      GATEWAY_PUBLIC_URL: 'https://acme-ai-gateway.acme.workers.dev',
      CLOUDFLARE_SANDBOX_BRIDGE_URL: bridgeUrl,
    });
    expect(manager).not.toHaveProperty('MASTER_ENCRYPTION_KEY');
    expect(manager).not.toHaveProperty('DATABASE_URL');
    expect(retentionPuts(calls).map(([name]) => name)).toEqual([
      'CONTROL_PLANE_URL',
      'CRON_SECRET',
    ]);
  });

  it('gives the AW_PUBLIC_URL in .env to the control plane alone (#955)', async () => {
    const target = await cloudflareProject();
    await appendEnv(target, 'AW_PUBLIC_URL', 'https://agents.acme.example');
    const { runner, calls } = stubRunner(cloudflareResponder(true).respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(bulkFor(calls, 'acme-ai-control-plane')['AW_PUBLIC_URL']).toBe(
      'https://agents.acme.example',
    );
    expect(bulkFor(calls, 'acme-ai-gateway')).not.toHaveProperty('AW_PUBLIC_URL');
    expect(bulkFor(calls, 'acme-ai-manager')).not.toHaveProperty('AW_PUBLIC_URL');
    expect(putsOf(calls).map(([name]) => name)).not.toContain('AW_PUBLIC_URL');
  });
}

function registryImageCases(): void {
  it('does not push an image the registry already holds', async () => {
    const target = await cloudflareProject();
    const tags = [1, 2, 3]
      .map((character) => `agent-workspace-x  sha256-${String(character).repeat(64)}`)
      .join('\n');
    const { respond } = cloudflareResponder(true, { registryTags: tags });
    const { runner, calls } = stubRunner(respond);

    const { output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(calls.filter(({ tool }) => tool === 'docker').map(({ args }) => args[0])).toEqual([
      'run',
    ]);
    expect(calls.some(({ args }) => args[1] === 'push')).toBe(false);
    expect(output).toContain('is already in the Cloudflare registry');
  });

  it('pushes only the image the registry lacks', async () => {
    const target = await cloudflareProject();
    const tags = [1, 3].map((character) => `sha256-${String(character).repeat(64)}`).join('\n');
    const { respond } = cloudflareResponder(true, { registryTags: tags });
    const { runner, calls } = stubRunner(respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(calls.filter(({ args }) => args[1] === 'push').map(({ args }) => args[2])).toEqual([
      `agent-workspace-gateway:sha256-${'2'.repeat(64)}`,
    ]);
  });

  it('runs an image .env already names on registry.cloudflare.com as it is, without a push', async () => {
    const target = await cloudflareProject();
    const onCloudflare = `registry.cloudflare.com/acct123/aw-runner@${digest('3')}`;
    await editEnv(target, 'RUNNER_IMAGE', onCloudflare);
    const { respond, deployed } = cloudflareResponder(true);
    const { runner, calls } = stubRunner(respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(calls.filter(({ args }) => args[1] === 'push').map(({ args }) => args[2])).toEqual([
      `agent-workspace-web:sha256-${'1'.repeat(64)}`,
      `agent-workspace-gateway:sha256-${'2'.repeat(64)}`,
    ]);
    expect(calls.some(({ args }) => args.includes(onCloudflare) && args[0] !== 'run')).toBe(false);
    expect(deployed.get('acme-ai-manager')?.['containers']).toMatchObject([
      { image: onCloudflare },
    ]);
  });
}

function failureBeforeDeployCases(): void {
  it('stops before any Wrangler deploy when an image push fails', async () => {
    const target = await cloudflareProject();
    const { respond } = cloudflareResponder(true);
    const { runner, calls } = stubRunner((call) =>
      call.args[0] === 'containers' && call.args[1] === 'push'
        ? { status: 1, stderr: 'push denied' }
        : respond(call),
    );

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(message).toContain('`wrangler containers` failed');
    expect(calls.some(({ args }) => args[0] === 'deploy' || args[0] === 'run')).toBe(false);
    expect(calls.at(-1)?.args.slice(0, 2)).toEqual(['containers', 'push']);
  });

  it('stops before any Wrangler deploy when the migration fails', async () => {
    const target = await cloudflareProject();
    const { respond } = cloudflareResponder(true, { failRun: true });
    const { runner, calls } = stubRunner(respond);

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(message).toContain('`docker run` failed');
    expect(calls.some(({ args }) => args[0] === 'deploy')).toBe(false);
    expect(calls.at(-1)?.args[0]).toBe('run');
  });
}

function frontendCase(): void {
  it('deploys the frontend as static assets and allows exactly its origin on the control plane', async () => {
    const target = await cloudflareProject();
    const web = await frontend();
    const { respond, deployed } = cloudflareResponder(true);
    const { runner, calls } = stubRunner(respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: { ...cloudflareEnvironment, AGENT_WORKSPACE_FRONTEND: web },
      }),
    );

    const deploys = calls.filter(({ args }) => args[0] === 'deploy');
    expect(deploys.map(({ args }) => args[4])).toEqual([
      'acme-ai-gateway',
      'acme-ai-manager',
      'acme-ai-control-plane',
      'acme-ai-web',
    ]);
    const site = deploys[3];
    expect(site?.env['VITE_AW_BASE_URL']).toBe('https://app.example.com');
    expect(deployed.get('acme-ai-web')).toMatchObject({
      workers_dev: true,
      build: { command: 'npm run build', cwd: web },
      assets: { directory: path.join(web, 'dist'), not_found_handling: 'single-page-application' },
    });
    const origin = bulkFor(calls, 'acme-ai-control-plane')['AW_FRONTEND_ORIGIN'];
    expect(origin).toBe('https://acme-ai-web.acme.workers.dev');
    expect(origin).toMatch(/^https:\/\/[^*]+$/u);
    // The frontend goes after the control plane it points at, and holds no secret.
    expect(summary(calls).indexOf('wrangler secret bulk')).toBeLessThan(
      calls.findIndex((call) => call === site),
    );
    expect(bulksOf(calls).map(({ args }) => args[3])).not.toContain('acme-ai-web');
  });
}

describe('agent-workspace deploy to Cloudflare', () => {
  fullApplyCase();
  perWorkerSecretCases();
  registryImageCases();
  failureBeforeDeployCases();
  frontendCase();
});
