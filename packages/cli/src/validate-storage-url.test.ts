import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { renderProfileDocument } from './profile.js';
import { StorageSettingsRefusedError, runValidateCommand } from './validate.js';

import { gcpProfile, recordingProbes, validationDirectory } from './validate.test-support.ts';

const credentials = {
  OBJECT_STORAGE_ACCESS_KEY_ID: 'agent_workspace',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'object-store-secret',
};

const validateIn = async (environment: Record<string, string>) => {
  const directory = await validationDirectory();
  await writeFile(
    path.join(directory, 'agent-workspace.yaml'),
    renderProfileDocument(gcpProfile),
    'utf8',
  );
  const written: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  const inputs: unknown[] = [];
  const { probes } = recordingProbes({
    objects: (input) => {
      inputs.push(input);
      return Promise.resolve('present');
    },
  });
  const outcome = await runValidateCommand([directory], { probes, environment }).catch(
    (thrown: unknown) => thrown,
  );
  return { inputs, outcome, output: written.join('') };
};
describe('storage location selection', () => {
  it('[US-STO-10][api][cli] validate probes the bucket AW_STORAGE_URL names', async () => {
    const { inputs, outcome } = await validateIn({
      ...credentials,
      AW_STORAGE_URL: 's3://url-bucket?endpoint=https://objects.example&region=eu-west-1',
    });

    expect(outcome).toBeUndefined();
    expect(inputs).toEqual([
      {
        backend: 's3',
        bucket: 'url-bucket',
        region: 'eu-west-1',
        endpoint: 'https://objects.example',
        forcePathStyle: false,
        accessKeyId: 'agent_workspace',
        secretAccessKey: 'object-store-secret',
      },
    ]);
  });

  it('[US-STO-10][api][cli] validate never probes a bucket the old variables name, and says why', async () => {
    const { inputs, outcome, output } = await validateIn({
      ...credentials,
      OBJECT_STORAGE_BUCKET: 'old-bucket',
      OBJECT_STORAGE_ENDPOINT: 'https://objects.example',
      OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
    });

    expect(outcome).toBeUndefined();
    expect(inputs).toEqual([]);
    expect(output).toContain(
      'skipped  objects: AW_STORAGE_URL is not configured, so there is no bucket to probe',
    );
  });

  it('[US-STO-10][api][cli] validate ignores a legacy variable beside AW_STORAGE_URL', async () => {
    const { inputs, outcome } = await validateIn({
      AW_STORAGE_URL: 'file:///var/lib/agent-workspace',
      AW_FILE_STORAGE_ROOT: '/elsewhere/files',
    });

    expect(outcome).toBeUndefined();
    expect(inputs).toEqual([]);
  });
});

describe('storage setting refusals', () => {
  it('[US-STO-10][api][cli] validate refuses an endpoint on the app origin, as the server does', async () => {
    const { outcome } = await validateIn({
      ...credentials,
      AW_PUBLIC_URL: 'https://app.example',
      AW_STORAGE_URL: 's3://url-bucket?endpoint=https://app.example',
    });

    expect(outcome).toBeInstanceOf(StorageSettingsRefusedError);
    expect((outcome as Error).message).toContain('storage_endpoint_same_origin');
  });

  it('[US-STO-10][api][cli] validate refuses a malformed AW_STORAGE_CREATE_BUCKET as start-up does', async () => {
    const { inputs, outcome, output } = await validateIn({
      ...credentials,
      AW_STORAGE_URL: 's3://url-bucket',
      AW_STORAGE_CREATE_BUCKET: 'yes-secret-value',
    });

    expect(outcome).toBeInstanceOf(StorageSettingsRefusedError);
    expect((outcome as Error).message).toBe(
      'the storage setting is refused — AW_STORAGE_CREATE_BUCKET must be true or false.',
    );
    expect(inputs).toEqual([]);
    expect(output).not.toContain('yes-secret-value');
  });

  it('[US-STO-10][api][cli] validate never prints a credential-shaped AW_STORAGE_URL', async () => {
    const generated = randomBytes(12).toString('hex');
    const { outcome, output } = await validateIn({
      AW_STORAGE_URL: `s3://url-bucket?X-Amz-Credential=${generated}`,
    });

    expect(outcome).toBeInstanceOf(StorageSettingsRefusedError);
    expect((outcome as Error).message).toMatch(
      /^the storage setting is refused — AW_STORAGE_URL is invalid/u,
    );
    expect((outcome as Error).message).not.toContain(generated);
    expect(output).not.toContain(generated);
  });
});
