import type { ProductionGcp } from '@indx-workspace/contracts/project-file';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { gcpProject, PROJECT, REGION } from './gcp-fixtures.test-support.ts';
import { commandLine } from './gcp-runner.test-support.ts';
import { captured, scenario } from './gcp-scenario.test-support.ts';
import type { ToolInvocation, ToolRunner } from './runner.js';

const SECRET = 'oidc-Client-S3cret-0123456789';

const oidc = { issuer: 'https://accounts.example.com', clientId: 'client-1' };

const withOidc = async (extra: Partial<ProductionGcp> = {}) => ({
  project: await gcpProject('acme-ai', { oidc, ...extra }),
});

const secretCalls = (calls: readonly ToolInvocation[]) =>
  calls.map(commandLine).filter((line) => line.startsWith('gcloud secrets'));

it('asks once, creates the secret with a targeted apply and stores the value on stdin only', async () => {
  const { run, calls } = await scenario(await withOidc());
  const readSecret = vi.fn(() => Promise.resolve(SECRET));

  await run({ readSecret });

  expect(readSecret).toHaveBeenCalledTimes(1);
  const lines = calls.map(commandLine);
  const created = lines.findIndex((line) =>
    line.includes('-target=google_secret_manager_secret.oidc_client_secret[0]'),
  );
  const added = lines.findIndex((line) => line.startsWith('gcloud secrets versions add'));
  const copy = lines.findIndex((line) => line.startsWith('docker buildx imagetools create'));
  expect(created).toBeGreaterThan(-1);
  expect(added).toBeGreaterThan(created);
  expect(copy).toBeGreaterThan(added);
  expect(lines[added]).toBe(
    `gcloud secrets versions add acme-ai-oidc-client-secret --project ${PROJECT} --data-file=-`,
  );
  expect(calls[added]?.input).toBe(SECRET);
  expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(SECRET);
  expect(captured.output).toContain('Store the sign-in client secret: done');
  expect(captured.output).not.toContain(SECRET);
});

it('asks for nothing on a re-run that finds a version', async () => {
  const { run, calls, world } = await scenario(await withOidc());
  await run({ readSecret: () => Promise.resolve(SECRET) });
  world.planExit = 0;
  const before = calls.length;
  const readSecret = vi.fn(() => Promise.resolve(SECRET));

  await run({ readSecret });

  expect(readSecret).not.toHaveBeenCalled();
  expect(secretCalls(calls.slice(before)).some((line) => line.includes('versions add'))).toBe(
    false,
  );
  expect(calls.slice(before).some((call) => commandLine(call).includes('-target='))).toBe(false);
});

it.each([
  ['client id', { issuer: oidc.issuer, clientId: 'client-2' }],
  ['issuer', { issuer: 'https://other.example.com', clientId: oidc.clientId }],
])('asks again when the %s changes while a version is stored', async (_label, changed) => {
  const first = await scenario(await withOidc());
  await first.run({ readSecret: () => Promise.resolve(SECRET) });
  const { run, calls } = await scenario(
    { project: await gcpProject('acme-ai', { oidc: changed }) },
    {
      secretExists: true,
      secretVersion: true,
      ...(first.world.secretFingerprint === undefined
        ? {}
        : { secretFingerprint: first.world.secretFingerprint }),
    },
  );
  const readSecret = vi.fn(() => Promise.resolve('new-S3cret-0123456789'));

  await run({ readSecret });

  expect(readSecret).toHaveBeenCalledTimes(1);
  const lines = calls.map(commandLine);
  expect(lines.some((line) => line.startsWith('gcloud secrets versions add'))).toBe(true);
  expect(lines.some((line) => line.startsWith('gcloud secrets update'))).toBe(true);
});

it('reads AW_OIDC_CLIENT_SECRET when the terminal is not interactive', async () => {
  const { run, calls } = await scenario({
    ...(await withOidc()),
    env: { AW_OIDC_CLIENT_SECRET: SECRET },
  });

  await run();

  const add = calls.find((call) => commandLine(call).startsWith('gcloud secrets versions add'));
  expect(add?.input).toBe(SECRET);
});

it('refuses, naming both ways, when there is no terminal and no environment value', async () => {
  const { run, calls } = await scenario(await withOidc());

  const failure = await run().then(
    () => '',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect(failure).toContain('Store the sign-in client secret failed');
  expect(failure).toContain('AW_OIDC_CLIENT_SECRET');
  expect(failure).toContain('in a terminal');
  expect(calls.map(commandLine).some((line) => line.includes('imagetools create'))).toBe(false);
});

it('only notes that the secret will be asked for without --yes', async () => {
  const { run, calls } = await scenario({ ...(await withOidc()), apply: false }, { bucket: true });
  const readSecret = vi.fn(() => Promise.resolve(SECRET));

  await run({ readSecret });

  expect(readSecret).not.toHaveBeenCalled();
  expect(secretCalls(calls)).toEqual([]);
  expect(captured.output).toContain(
    'asks once for the client secret of https://accounts.example.com',
  );
});

it('masks the secret in what a later step prints', async () => {
  const setup = await scenario(await withOidc());
  let applies = 0;
  const runner: ToolRunner = (invocation) => {
    // The fourth apply is the full one, after the foundation, the secret and Cloud SQL.
    if (commandLine(invocation).startsWith('terraform apply') && ++applies === 4) {
      return Promise.resolve({
        status: 1,
        stdout: '',
        stderr: `Error: rejected the value ${SECRET}\n`,
      });
    }
    return setup.runner(invocation);
  };

  await setup.run({ runner, readSecret: () => Promise.resolve(SECRET) }).catch(() => undefined);

  expect(applies).toBe(4);
  expect(captured.output).not.toContain(SECRET);
  expect(captured.output).toContain('rejected the value ***');
});

it('names the sign-in, the domain and the DNS record in the summary', async () => {
  const { run } = await scenario(await withOidc({ domain: 'agents.example.com' }), {
    loadBalancerIp: '203.0.113.7',
  });

  const outcome = await run({ readSecret: () => Promise.resolve(SECRET) });

  expect(outcome.nextSteps.slice(0, 3)).toEqual([
    'web: https://agents.example.com',
    'next: point agents.example.com at 203.0.113.7',
    'sign-in: single sign-on through https://accounts.example.com; the Owner password stays as a break-glass sign-in',
  ]);
});

it('writes domain, armor, iap and the oidc settings as Terraform variables, only when set', async () => {
  const { run, moduleDirectory } = await scenario(
    await withOidc({ domain: 'agents.example.com', armor: true, iap: false }),
  );

  await run({ readSecret: () => Promise.resolve(SECRET) });

  expect(
    JSON.parse(await readFile(path.join(moduleDirectory, 'terraform.tfvars.json'), 'utf8')),
  ).toEqual({
    project_id: PROJECT,
    region: REGION,
    name: 'acme-ai',
    vertex_location: 'global',
    domain: 'agents.example.com',
    armor: true,
    iap: false,
    oidc_issuer: oidc.issuer,
    oidc_client_id: oidc.clientId,
  });
});
