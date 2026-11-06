import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { IGNORED_STORAGE_VARIABLES } from '@indx-workspace/contracts/storage-settings';
import { describe, expect, it } from 'vitest';

import { runDeployCommand } from './command.js';
import {
  captured,
  capturedFailure,
  databaseUrl,
  oldStorageLines,
  setStorage,
  stubRunner,
} from './deploy.test-support.js';
import {
  bulkFor,
  cloudflareEnvironment,
  cloudflareProject,
  cloudflareResponder,
  controlPlanePuts,
  editEnv,
  pushedLocation,
} from './deploy.cloudflare.test-support.js';

function storageUrlCases(): void {
  // @story US-STO-10
  it('[US-STO-10][api][cli] deploy to cloudflare reads the bucket from AW_STORAGE_URL', async () => {
    const target = await cloudflareProject();
    const { runner, calls } = stubRunner(cloudflareResponder(true).respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    const r2 = calls.filter(({ args }) => args[0] === 'r2').map(({ args }) => args.slice(1));
    expect(r2).toEqual([['bucket', 'info', 'acme-ai-files']]);
    expect(pushedLocation(calls)).toMatchObject({
      kind: 's3',
      bucket: 'acme-ai-files',
      endpoint: 'https://acct123.r2.cloudflarestorage.com',
      region: 'auto',
    });
    expect(controlPlanePuts(calls).map(([name]) => name)).not.toContain('OBJECT_STORAGE_ENDPOINT');
  });

  // @story US-STO-10
  it('[US-STO-10][api][cli] deploy to cloudflare keeps the endpoint and region a URL names', async () => {
    const target = await cloudflareProject();
    await setStorage(target, [
      'AW_STORAGE_URL=s3://eu-files/data?endpoint=https%3A%2F%2Feu.example.com&region=eu',
    ]);
    const { runner, calls } = stubRunner(cloudflareResponder(true).respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(pushedLocation(calls)).toMatchObject({
      bucket: 'eu-files',
      prefix: 'data',
      endpoint: 'https://eu.example.com',
      region: 'eu',
    });
  });

  // @story US-STO-10
  it('[US-STO-10][api][cli] deploy to cloudflare refuses a URL that is not s3://', async () => {
    const target = await cloudflareProject();
    await setStorage(target, ['AW_STORAGE_URL=gcs://acme-ai-files']);
    const { runner, calls } = stubRunner(cloudflareResponder(true).respond);
    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );
    expect(message).toContain('must be an s3:// URL');
    expect(calls.some(({ args }) => args[0] === 'r2' || args[1] === 'bulk')).toBe(false);
  });
}

function oldStorageNameCases(): void {
  // @story US-STO-10
  it('[US-STO-10][api][cli] deploy to cloudflare warns about old storage names next to AW_STORAGE_URL and never translates them', async () => {
    const target = await cloudflareProject();
    const secret = `bucket-${randomUUID()}`;
    await setStorage(target, ['AW_STORAGE_URL=s3://acme-ai-files', ...oldStorageLines(secret)]);
    const { runner, calls } = stubRunner(cloudflareResponder(true).respond);

    const { output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(output).toContain('storage_setting_ignored: ignoring OBJECT_STORAGE_BUCKET,');
    expect(output).not.toContain(secret);
    expect(calls.filter(({ args }) => args[0] === 'r2').map(({ args }) => args.slice(1))).toEqual([
      ['bucket', 'info', 'acme-ai-files'],
    ]);
    expect(pushedLocation(calls)).toMatchObject({
      bucket: 'acme-ai-files',
      endpoint: 'https://acct123.r2.cloudflarestorage.com',
    });
  });

  // @story US-STO-10
  it('[US-STO-10][api][cli] deploy to cloudflare refuses a .env with only old storage names, as vercel does, without their values', async () => {
    const target = await cloudflareProject();
    const secret = `bucket-${randomUUID()}`;
    await setStorage(target, oldStorageLines(secret));
    const { runner, calls } = stubRunner(cloudflareResponder(true).respond);

    const { message, output } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(message).toContain('AW_STORAGE_URL is empty in .env');
    expect(message).toContain('Nothing was run');
    expect(output).toContain('storage_setting_ignored: ignoring OBJECT_STORAGE_BUCKET,');
    expect(`${message}${output}`).not.toContain(secret);
    expect(calls).toEqual([]);
  });
}

function oldNamesNotPushedAndControlPlane(): void {
  // @story US-STO-10
  it('[US-STO-10][api][cli] deploy to cloudflare warns once and pushes none of the old storage names', async () => {
    const target = await cloudflareProject();
    const secret = `bucket-${randomUUID()}`;
    await setStorage(target, [
      'AW_STORAGE_URL=s3://acme-ai-files',
      ...IGNORED_STORAGE_VARIABLES.map((name) => `${name}=${secret}`),
    ]);
    const { runner, calls } = stubRunner(cloudflareResponder(true).respond);

    const { output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(output.match(/storage_setting_ignored/gu)).toHaveLength(1);
    const pushed = bulkFor(calls, 'acme-ai-control-plane');
    expect(pushed['AW_STORAGE_URL']).toBeDefined();
    for (const name of IGNORED_STORAGE_VARIABLES) expect(pushed[name], name).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain(secret);
  });

  it('gives the control plane what the secrets service and file storage read', async () => {
    const target = await cloudflareProject();
    await editEnv(target, 'OBJECT_STORAGE_ACCESS_KEY_ID', 'r2-access-key');
    await editEnv(target, 'OBJECT_STORAGE_SECRET_ACCESS_KEY', 'r2-secret-key');
    const { runner, calls } = stubRunner(cloudflareResponder(true).respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    const controlPlane = bulkFor(calls, 'acme-ai-control-plane');
    // `createSecretsService`: a database, and the `local-key` provider's 32-byte hex master key.
    expect(controlPlane['DATABASE_URL']).toBe(databaseUrl);
    expect(controlPlane['MASTER_KEY_PROVIDER']).toBe('local-key');
    expect(controlPlane['MASTER_ENCRYPTION_KEY']).toMatch(/^[0-9a-f]{64}$/iu);
    // The S3 adapter reads `AWS_*`, `OBJECT_STORAGE_*` alone leave R2 without credentials.
    expect(controlPlane).toMatchObject({
      AWS_ACCESS_KEY_ID: 'r2-access-key',
      AWS_SECRET_ACCESS_KEY: 'r2-secret-key',
      AWS_REGION: 'auto',
    });
  });
}

function keyPairCases(): void {
  it.each(['OBJECT_STORAGE_ACCESS_KEY_ID', 'OBJECT_STORAGE_SECRET_ACCESS_KEY'])(
    'refuses an apply whose .env has no %s, by name, before any tool runs',
    async (name) => {
      const target = await cloudflareProject();
      await editEnv(target, name, '');
      const { runner, calls } = stubRunner(() => ({}));

      const { message, output } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
      );

      expect(message).toContain(`${name} is empty in .env`);
      expect(message).toContain('Nothing was run');
      expect(`${message}${output}`).not.toContain('r2-secret-key');
      expect(calls).toEqual([]);
    },
  );

  it('accepts the R2 key pair under the AWS_* names', async () => {
    const target = await cloudflareProject();
    await editEnv(target, 'OBJECT_STORAGE_ACCESS_KEY_ID', '');
    await editEnv(target, 'OBJECT_STORAGE_SECRET_ACCESS_KEY', '');
    const file = path.join(target, '.env');
    await writeFile(
      file,
      `${await readFile(file, 'utf8')}AWS_ACCESS_KEY_ID=aws-key\nAWS_SECRET_ACCESS_KEY=aws-secret\n`,
    );
    const { runner, calls } = stubRunner(cloudflareResponder(true).respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(bulkFor(calls, 'acme-ai-control-plane')).toMatchObject({
      AWS_ACCESS_KEY_ID: 'aws-key',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
    });
  });
}

function r2BucketCases(): void {
  it('does not create an R2 bucket that exists', async () => {
    const target = await cloudflareProject();
    const { runner, calls } = stubRunner(cloudflareResponder(true).respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    const r2 = calls.filter(({ args }) => args[0] === 'r2').map(({ args }) => args.slice(1));
    expect(r2).toEqual([['bucket', 'info', 'acme-ai-files']]);
  });

  it('creates the R2 bucket when it is missing, before the migrations run', async () => {
    const target = await cloudflareProject();
    const { respond } = cloudflareResponder(true, { bucket: 'missing' });
    const { runner, calls } = stubRunner(respond);

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    const names = calls.map(({ tool, args }) => `${tool} ${args.slice(0, 3).join(' ')}`);
    expect(names).toContain('wrangler r2 bucket info');
    const create = names.indexOf('wrangler r2 bucket create');
    expect(calls[create]?.args.at(-1)).toBe('acme-ai-files');
    expect(create).toBeGreaterThan(names.indexOf('wrangler r2 bucket info'));
    expect(create).toBeLessThan(names.findIndex((name) => name.startsWith('docker run')));
  });

  it('does not create a bucket when `r2 bucket info` fails for another reason', async () => {
    const target = await cloudflareProject();
    const { respond } = cloudflareResponder(true, { bucket: 'denied' });
    const { runner, calls } = stubRunner(respond);

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: cloudflareEnvironment }),
    );

    expect(message).toContain('did not say the bucket is missing');
    expect(calls.some(({ args }) => args[0] === 'r2' && args[2] === 'create')).toBe(false);
    expect(calls.some(({ args }) => args[0] === 'run' || args[0] === 'deploy')).toBe(false);
    expect(calls.some(({ args }) => args[0] === 'pull' || args[1] === 'push')).toBe(false);
  });
}

describe('agent-workspace deploy to Cloudflare', () => {
  storageUrlCases();
  oldStorageNameCases();
  oldNamesNotPushedAndControlPlane();
  keyPairCases();
  r2BucketCases();
});
