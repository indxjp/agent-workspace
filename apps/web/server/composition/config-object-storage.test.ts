import { describe, expect, it } from 'vitest';

import { configuredObjectStorageBackend } from './config';

describe('object-storage backend selection', () => {
  it('keeps the historic implicit selection and accepts each closed-world backend', () => {
    expect(configuredObjectStorageBackend({})).toBeNull();
    expect(configuredObjectStorageBackend({ OBJECT_STORAGE_BACKEND: 's3' })).toBe('s3');
    expect(configuredObjectStorageBackend({ OBJECT_STORAGE_BACKEND: 'gcs' })).toBe('gcs');
    expect(configuredObjectStorageBackend({ OBJECT_STORAGE_BACKEND: 'azure-blob' })).toBe(
      'azure-blob',
    );
  });

  it('refuses an unknown backend instead of falling back to local storage', () => {
    expect(() => configuredObjectStorageBackend({ OBJECT_STORAGE_BACKEND: 'gc' })).toThrow(
      /OBJECT_STORAGE_BACKEND must be s3, gcs, or azure-blob/u,
    );
  });
});
