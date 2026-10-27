import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeListedFile {
  readonly name: string;
  readonly metadata: {
    readonly size: string;
    readonly updated: string;
    readonly metadata?: Readonly<Record<string, string>>;
  };
}
const getFiles = vi.fn<() => Promise<[FakeListedFile[]]>>();

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket(name: string) {
      return { name, getFiles };
    }
  },
}));

import { createGcsObjectStoreProviderFromConfig, GcsBucketUnavailableError } from './gcs-store.js';

describe('native GCS readiness', () => {
  beforeEach(() => {
    getFiles.mockReset();
  });

  it('refuses a missing bucket so composition leaves the API on its concealing 503 path', async () => {
    getFiles.mockRejectedValue(Object.assign(new Error('Not Found'), { code: 404 }));
    await expect(
      createGcsObjectStoreProviderFromConfig({ bucket: 'missing-bucket' }),
    ).rejects.toBeInstanceOf(GcsBucketUnavailableError);
  });

  it('does not repeat provider details in the readiness error composition logs', () => {
    const providerDetail = 'credential=secret-value';
    const error = new GcsBucketUnavailableError(
      'private-bucket',
      'unreachable',
      new Error(providerDetail),
    );
    expect(error.message).not.toContain(providerDetail);
    expect(error.message).not.toContain('credential');
  });

  it('keeps missing and unreachable readiness outcomes distinct without exposing a cause', async () => {
    getFiles
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { code: 404 }))
      .mockRejectedValueOnce(new Error('token=secret'));
    const missing = await createGcsObjectStoreProviderFromConfig({ bucket: 'missing' }).catch(
      (error: unknown) => error,
    );
    const unreachable = await createGcsObjectStoreProviderFromConfig({ bucket: 'private' }).catch(
      (error: unknown) => error,
    );

    expect(missing).toMatchObject({ reason: 'missing' });
    expect(unreachable).toMatchObject({ reason: 'unreachable' });
    expect((unreachable as Error).message).not.toContain('token=secret');
  });

  it('preserves the safe trailing delimiter used for a prefixed native listing', async () => {
    getFiles.mockResolvedValue([[]]);
    const provider = await createGcsObjectStoreProviderFromConfig({
      bucket: 'available-bucket',
      keyPrefix: 'files',
    });
    await expect(
      provider.forWorkspace('11111111-1111-4111-8111-111111111111').list(''),
    ).resolves.toEqual([]);
    expect(getFiles).toHaveBeenCalledWith({
      maxResults: 1,
      autoPaginate: false,
      prefix: 'files/',
    });
    expect(getFiles).toHaveBeenCalledWith({
      prefix: 'files/workspaces/11111111-1111-4111-8111-111111111111/',
    });
  });

  it('drops native names outside the key grammar instead of failing the whole listing', async () => {
    getFiles.mockResolvedValue([
      [
        {
          name: 'files/workspaces/11111111-1111-4111-8111-111111111111/reports/',
          metadata: { size: '0', updated: '2026-09-23T00:00:00.000Z' },
        },
        {
          name: 'files/workspaces/11111111-1111-4111-8111-111111111111/foreign%name.txt',
          metadata: { size: '0', updated: '2026-09-23T00:00:00.000Z' },
        },
        {
          name: 'files/workspaces/11111111-1111-4111-8111-111111111111/visible.txt',
          metadata: {
            size: '7',
            updated: '2026-09-23T00:00:00.000Z',
            metadata: { 'aw-content-type-known': 'true' },
          },
        },
      ],
    ]);
    const provider = await createGcsObjectStoreProviderFromConfig({
      bucket: 'available-bucket',
      keyPrefix: 'files',
    });

    await expect(
      provider.forWorkspace('11111111-1111-4111-8111-111111111111').list(''),
    ).resolves.toEqual([expect.objectContaining({ kind: 'file', key: 'visible.txt' })]);
  });
});
