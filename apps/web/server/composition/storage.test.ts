import type { DatabaseRoot } from '@agent-workspace/core/db';
import {
  createInMemoryObjectStoreProvider,
  type AzureBlobObjectStoreConfig,
  type ObjectStoreProvider,
  type S3ObjectStoreConfig,
} from '@agent-workspace/core/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const injected = vi.hoisted(() => ({
  filesAzure: vi.fn<(config: AzureBlobObjectStoreConfig) => Promise<ObjectStoreProvider>>(),
  filesLocal: vi.fn<(root: string) => ObjectStoreProvider>(),
  filesS3: vi.fn<(config: S3ObjectStoreConfig) => Promise<ObjectStoreProvider>>(),
  skillsAzure: vi.fn<(config: AzureBlobObjectStoreConfig) => Promise<ObjectStoreProvider>>(),
  skillsLocal: vi.fn<(root: string) => ObjectStoreProvider>(),
  skillsS3: vi.fn<(config: S3ObjectStoreConfig) => Promise<ObjectStoreProvider>>(),
}));

vi.mock('../files/object-store-bridge', () => ({
  createAzureBlobObjectStoreProviderFromConfig: injected.filesAzure,
  createLocalFilesystemObjectStoreProvider: injected.filesLocal,
  createS3ObjectStoreProviderFromConfig: injected.filesS3,
}));

vi.mock('../skills/object-store-bridge', () => ({
  createAzureBlobObjectStoreProviderFromConfig: injected.skillsAzure,
  createLocalFilesystemObjectStoreProvider: injected.skillsLocal,
  createS3ObjectStoreProviderFromConfig: injected.skillsS3,
}));

import { clearFilesRuntime, currentFilesRuntime, type WorkspaceResolution } from '../files/runtime';
import type { ResourceCatalogStoreProvider } from '../resources/catalog-store';
import { clearSkillsRuntime, currentSkillsRuntime } from '../skills/runtime';
import { installFilesApi, installSkillsApi, storageReadinessFailure } from './storage';

const scopes: DatabaseRoot['scopes'] = {
  forWorkspaceId: () => Promise.resolve(null),
  forWorkspaceSlug: () => Promise.resolve(null),
};
const catalog: ResourceCatalogStoreProvider = {
  forWorkspace: () => Promise.reject(new Error('the composition test never reads the catalog')),
};
const resolveWorkspace = (): Promise<WorkspaceResolution> =>
  Promise.resolve({ kind: 'unauthenticated', reason: 'composition test' });

function setObjectStoreEnvironment(input: {
  readonly backend?: string;
  readonly bucket?: string;
  readonly endpoint?: string;
}): void {
  vi.stubEnv('OBJECT_STORAGE_BACKEND', input.backend ?? '');
  vi.stubEnv('OBJECT_STORAGE_BUCKET', input.bucket ?? '');
  vi.stubEnv('OBJECT_STORAGE_ENDPOINT', input.endpoint ?? '');
  vi.stubEnv('OBJECT_STORAGE_FORCE_PATH_STYLE', 'false');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'access-key');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret-key');
  vi.stubEnv('AWS_REGION', 'eu-west-1');
  vi.stubEnv('AZURE_CLIENT_ID', '11111111-1111-1111-1111-111111111111');
  vi.stubEnv('AW_FILE_STORAGE_ROOT', 'C:\\agent-workspace\\files');
  vi.stubEnv('AW_SKILL_STORAGE_ROOT', 'C:\\agent-workspace\\skills');
}

beforeEach(() => {
  clearFilesRuntime();
  clearSkillsRuntime();
  const provider = createInMemoryObjectStoreProvider();
  injected.filesAzure.mockResolvedValue(provider);
  injected.filesLocal.mockReturnValue(provider);
  injected.filesS3.mockResolvedValue(provider);
  injected.skillsAzure.mockResolvedValue(provider);
  injected.skillsLocal.mockReturnValue(provider);
  injected.skillsS3.mockResolvedValue(provider);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  clearFilesRuntime();
  clearSkillsRuntime();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('storageReadinessFailure', () => {
  it('reports only bounded provider metadata and never copies credential-bearing causes', () => {
    const secret = 'AKIA-DO-NOT-LOG';
    const cause = Object.assign(
      new Error(`request to https://${secret}:password@s3.example.invalid failed`),
      { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } },
    );
    const message = storageReadinessFailure('files', cause);

    expect(message).toBe(
      '[compose] files API NOT installed: object storage failed readiness (name=AccessDenied, status=403).',
    );
    expect(message).not.toContain(secret);
    expect(message).not.toContain('password');
    expect(message).not.toContain('s3.example.invalid');
  });

  it('rejects unbounded provider metadata instead of copying it into logs', () => {
    expect(
      storageReadinessFailure('skills', {
        name: 'credential-bearing-name',
        $metadata: { httpStatusCode: '403 and a secret' },
      }),
    ).toBe(
      '[compose] skills API NOT installed: object storage failed readiness (name=UnknownProviderError, status=unknown).',
    );
  });
});

describe('cloud object-store composition', () => {
  it('dispatches files and skills to Azure Blob with their distinct prefixes', async () => {
    setObjectStoreEnvironment({
      backend: 'azure-blob',
      bucket: 'workspace-objects',
      endpoint: 'https://account.blob.core.windows.net',
    });

    await installFilesApi(resolveWorkspace, scopes, catalog);
    await installSkillsApi(resolveWorkspace, scopes, catalog);

    expect(injected.filesAzure).toHaveBeenCalledWith({
      serviceUrl: 'https://account.blob.core.windows.net',
      container: 'workspace-objects',
      managedIdentityClientId: '11111111-1111-1111-1111-111111111111',
      keyPrefix: 'files',
    });
    expect(injected.skillsAzure).toHaveBeenCalledWith({
      serviceUrl: 'https://account.blob.core.windows.net',
      container: 'workspace-objects',
      managedIdentityClientId: '11111111-1111-1111-1111-111111111111',
      keyPrefix: 'skills',
    });
    expect(currentFilesRuntime()).not.toBeNull();
    expect(currentSkillsRuntime()).not.toBeNull();
  });

  it('never creates a bucket selected through the explicit S3 backend', async () => {
    setObjectStoreEnvironment({ backend: 's3', bucket: 'workspace-objects' });

    await installFilesApi(resolveWorkspace, scopes, catalog);
    await installSkillsApi(resolveWorkspace, scopes, catalog);

    expect(injected.filesS3).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'workspace-objects',
        createBucketIfMissing: false,
        keyPrefix: 'files',
      }),
    );
    expect(injected.skillsS3).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'workspace-objects',
        createBucketIfMissing: false,
        keyPrefix: 'skills',
      }),
    );
  });

  it('preserves first-boot bucket creation for the bundled S3-compatible endpoint', async () => {
    setObjectStoreEnvironment({
      bucket: 'workspace-objects',
      endpoint: 'http://seaweedfs.example.test',
    });

    await installFilesApi(resolveWorkspace, scopes, catalog);
    await installSkillsApi(resolveWorkspace, scopes, catalog);

    expect(injected.filesS3).toHaveBeenCalledWith(
      expect.objectContaining({ createBucketIfMissing: true, keyPrefix: 'files' }),
    );
    expect(injected.skillsS3).toHaveBeenCalledWith(
      expect.objectContaining({ createBucketIfMissing: true, keyPrefix: 'skills' }),
    );
  });

  it('leaves both runtimes unconfigured when Azure has no endpoint', async () => {
    setObjectStoreEnvironment({ backend: 'azure-blob', bucket: 'workspace-objects' });

    await installFilesApi(resolveWorkspace, scopes, catalog);
    await installSkillsApi(resolveWorkspace, scopes, catalog);

    expect(injected.filesAzure).not.toHaveBeenCalled();
    expect(injected.skillsAzure).not.toHaveBeenCalled();
    expect(currentFilesRuntime()).toBeNull();
    expect(currentSkillsRuntime()).toBeNull();
  });

  it('leaves both runtimes unconfigured when the container readiness check rejects', async () => {
    setObjectStoreEnvironment({
      backend: 'azure-blob',
      bucket: 'missing-container',
      endpoint: 'https://account.blob.core.windows.net',
    });
    injected.filesAzure.mockRejectedValue(new Error('missing container'));
    injected.skillsAzure.mockRejectedValue(new Error('missing container'));

    await installFilesApi(resolveWorkspace, scopes, catalog);
    await installSkillsApi(resolveWorkspace, scopes, catalog);

    expect(currentFilesRuntime()).toBeNull();
    expect(currentSkillsRuntime()).toBeNull();
  });

  it('fails closed on an unknown backend instead of falling through to local storage', async () => {
    setObjectStoreEnvironment({ backend: 'typo', bucket: 'workspace-objects' });

    await installFilesApi(resolveWorkspace, scopes, catalog);
    await installSkillsApi(resolveWorkspace, scopes, catalog);

    expect(injected.filesLocal).not.toHaveBeenCalled();
    expect(injected.skillsLocal).not.toHaveBeenCalled();
    expect(currentFilesRuntime()).toBeNull();
    expect(currentSkillsRuntime()).toBeNull();
  });

  it('retains the local-filesystem fallback only when object-store selection is blank', async () => {
    setObjectStoreEnvironment({});

    await installFilesApi(resolveWorkspace, scopes, catalog);
    await installSkillsApi(resolveWorkspace, scopes, catalog);

    expect(injected.filesLocal).toHaveBeenCalledWith('C:\\agent-workspace\\files');
    expect(injected.skillsLocal).toHaveBeenCalledWith('C:\\agent-workspace\\skills');
    expect(currentFilesRuntime()).not.toBeNull();
    expect(currentSkillsRuntime()).not.toBeNull();
  });
});
