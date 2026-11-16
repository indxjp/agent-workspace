import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { PROJECT, REGION } from './gcp-fixtures.test-support.ts';
import { backendFor, initialiseBackend } from './gcp-lifecycle.js';
import { ok } from './gcp-runner.test-support.ts';
import { home } from './gcp-scenario.test-support.ts';
import type { ToolInvocation } from './runner.js';
import type { DeployContext } from './steps.js';

async function initialised() {
  const moduleDirectory = path.join(await home(), 'module');
  await mkdir(moduleDirectory, { recursive: true });
  await writeFile(path.join(moduleDirectory, 'versions.tf'), 'required_version = ">= 1.8.0"\n');
  const calls: ToolInvocation[] = [];
  const context: DeployContext = {
    runner: async (invocation) => {
      calls.push(invocation);
      await mkdir(path.join(moduleDirectory, '.terraform'), { recursive: true });
      return ok();
    },
    directory: '/project',
    env: {},
    cloud: 'gcp',
    out: () => undefined,
    err: () => undefined,
  };
  const backend = backendFor({ project: PROJECT, region: REGION }, 'acme-ai');
  return { moduleDirectory, calls, context, backend };
}

it('runs init again, without -upgrade, when the module versions.tf changes between runs', async () => {
  const { moduleDirectory, calls, context, backend } = await initialised();

  expect(await initialiseBackend(context, moduleDirectory, backend)).toBe(true);
  expect(await initialiseBackend(context, moduleDirectory, backend)).toBe(false);
  await writeFile(
    path.join(moduleDirectory, 'versions.tf'),
    'required_version = ">= 1.8.0"\n# google ~> 7.0\n',
  );
  expect(await initialiseBackend(context, moduleDirectory, backend)).toBe(true);

  expect(calls).toHaveLength(2);
  expect(calls[1]?.args).toContain('-reconfigure');
  expect(calls[1]?.args).not.toContain('-upgrade');
  expect(await initialiseBackend(context, moduleDirectory, backend)).toBe(false);
});

it('runs init again, without -upgrade, when only the shipped lock file changes', async () => {
  const { moduleDirectory, calls, context, backend } = await initialised();
  const lock = path.join(moduleDirectory, '.terraform.lock.hcl');
  await writeFile(lock, '# lock 1\n');
  expect(await initialiseBackend(context, moduleDirectory, backend)).toBe(true);
  expect(await initialiseBackend(context, moduleDirectory, backend)).toBe(false);

  await writeFile(lock, '# lock 2\n');

  expect(await initialiseBackend(context, moduleDirectory, backend)).toBe(true);
  expect(calls[1]?.args).not.toContain('-upgrade');
});

it('refuses to start a second stack beside one initialised for another backend', async () => {
  const { moduleDirectory, calls, context, backend } = await initialised();
  await mkdir(path.join(moduleDirectory, '.terraform'), { recursive: true });
  await writeFile(
    path.join(moduleDirectory, '.terraform', 'terraform.tfstate'),
    JSON.stringify({ backend: { type: 'gcs', config: { bucket: 'old-state', prefix: 'prod' } } }),
  );

  const failure = initialiseBackend(context, moduleDirectory, backend);

  await expect(failure).rejects.toThrow('init -migrate-state');
  await expect(failure).rejects.toThrow(`-backend-config=bucket=${PROJECT}-aw-tfstate`);
  expect(calls).toHaveLength(0);
});

it('refuses a module directory that holds local state', async () => {
  const { moduleDirectory, calls, context, backend } = await initialised();
  await writeFile(
    path.join(moduleDirectory, 'terraform.tfstate'),
    JSON.stringify({ version: 4, resources: [{ type: 'google_kms_key_ring' }] }),
  );

  await expect(initialiseBackend(context, moduleDirectory, backend)).rejects.toThrow(
    'second one beside it',
  );
  expect(calls).toHaveLength(0);
});

it('accepts the empty local state that init -migrate-state leaves beside a managed backend', async () => {
  const { moduleDirectory, calls, context, backend } = await initialised();
  await mkdir(path.join(moduleDirectory, '.terraform'), { recursive: true });
  await writeFile(
    path.join(moduleDirectory, '.terraform', 'terraform.tfstate'),
    JSON.stringify({ backend: { type: 'gcs', config: backend } }),
  );
  await writeFile(
    path.join(moduleDirectory, 'terraform.tfstate'),
    JSON.stringify({ version: 4, serial: 3, resources: [] }),
  );

  expect(await initialiseBackend(context, moduleDirectory, backend)).toBe(true);
  expect(calls).toHaveLength(1);
});

it('accepts a directory already initialised for the managed backend', async () => {
  const { moduleDirectory, context, backend } = await initialised();
  await mkdir(path.join(moduleDirectory, '.terraform'), { recursive: true });
  await writeFile(
    path.join(moduleDirectory, '.terraform', 'terraform.tfstate'),
    JSON.stringify({ backend: { type: 'gcs', config: backend } }),
  );

  expect(await initialiseBackend(context, moduleDirectory, backend)).toBe(true);
});
