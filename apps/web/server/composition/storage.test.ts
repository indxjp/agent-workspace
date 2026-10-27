import { randomBytes, randomUUID } from 'node:crypto';

import { log as webLogger } from '../telemetry/logger';
import { createInMemoryStorageMigrationRuns, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  type ObjectStoreProvider,
  type ObjectStoreV2,
  type OpenObjectStoreOptions,
  type StorageArea,
} from '@agent-workspace/core/storage';
import type { StorageLocation } from '@indx-workspace/contracts/storage-url';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const injected = vi.hoisted(() => ({
  open: vi.fn<
    (
      location: StorageLocation,
      area: StorageArea,
      options?: OpenObjectStoreOptions,
    ) => Promise<ObjectStoreProvider>
  >(),
  openRoot:
    vi.fn<
      (location: StorageLocation, options?: OpenObjectStoreOptions) => Promise<ObjectStoreV2>
    >(),
}));

vi.mock('@agent-workspace/core/storage', async (original) => ({
  ...(await original<typeof import('@agent-workspace/core/storage')>()),
  openObjectStore: injected.open,
  openRootObjectStore: injected.openRoot,
}));

import { SIGNED_UPLOAD_HARD_MAX_BYTES } from '@indx-workspace/contracts/files';
import { GET as listFilesRoute } from '../../app/api/files/route';
import { GET as listSkillsRoute } from '../../app/api/skills/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import type { WorkspaceResolution } from '../files/runtime';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import type { ResourceCatalogStoreProvider } from '../resources/catalog-store';
import { createStorageService } from '../storage/service';
import { purgeSessionAttachments } from '../surfaces/public/attachments';
import {
  installFilesApi,
  installSkillsApi,
  sessionStateBlobStore,
  storageReadinessFailure,
} from './storage';

const scopes: DatabaseRoot['scopes'] = {
  forWorkspaceId: () => Promise.resolve(null),
  forWorkspaceSlug: () => Promise.resolve(null),
};
const catalog: ResourceCatalogStoreProvider = {
  forWorkspace: () => Promise.reject(new Error('the composition test never reads the catalog')),
};
const fileTexts: DatabaseRoot['fileTexts'] = {
  forScope: () => {
    throw new Error('the composition test never reads file texts');
  },
};
const resolveWorkspace = (): Promise<WorkspaceResolution> =>
  Promise.resolve({ kind: 'unauthenticated', reason: 'composition test' });

function setStorageUrl(url = 'file:///srv/aw'): void {
  clearStorageEnvironment();
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'access-key');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret-key');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
  vi.stubEnv('AWS_REGION', 'eu-west-1');
  vi.stubEnv('AZURE_CLIENT_ID', '11111111-1111-1111-1111-111111111111');
  vi.stubEnv('AW_STORAGE_URL', url);
}

let logInfo: MockInstance<typeof webLogger.info>;
let logError: MockInstance<typeof webLogger.error>;

beforeEach(() => {
  const provider = createInMemoryObjectStoreProvider();
  injected.open.mockResolvedValue(provider);
  injected.openRoot.mockResolvedValue(createInMemoryObjectStore());
  logInfo = vi.spyOn(webLogger, 'info').mockImplementation(() => undefined);
  vi.spyOn(webLogger, 'warn').mockImplementation(() => undefined);
  logError = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
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
    setStorageUrl('azblob://account/workspace-objects');

    const files = await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);
    const skills = await installSkillsApi(resolveWorkspace, scopes, catalog);

    const azure = {
      kind: 'azblob',
      account: 'account',
      serviceUrl: 'https://account.blob.core.windows.net',
      container: 'workspace-objects',
      prefix: '',
    };
    const options = { managedIdentityClientId: '11111111-1111-1111-1111-111111111111' };
    expect(injected.open).toHaveBeenCalledTimes(4);
    expect(injected.open).toHaveBeenNthCalledWith(1, azure, 'files', options);
    expect(injected.open).toHaveBeenNthCalledWith(2, azure, 'skills', options);
    expect(injected.open).toHaveBeenNthCalledWith(3, azure, 'session-state', options);
    expect(injected.open).toHaveBeenNthCalledWith(4, azure, 'skills', options);
    expect(files.kind).toBe('serving');
    expect(skills.kind).toBe('serving');
  });

  it('never creates a bucket named by an S3 URL', async () => {
    setStorageUrl('s3://workspace-objects');

    await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);
    await installSkillsApi(resolveWorkspace, scopes, catalog);

    for (const area of ['files', 'skills']) {
      expect(injected.open).toHaveBeenCalledWith(
        {
          kind: 's3',
          bucket: 'workspace-objects',
          prefix: '',
          region: 'eu-west-1',
          forcePathStyle: false,
        },
        area,
        {
          credentials: { accessKeyId: 'access-key', secretAccessKey: 'secret-key' },
          createBucketIfMissing: false,
        },
      );
    }
  });

  it('forwards the session token of temporary AWS credentials with the key pair', async () => {
    setStorageUrl('s3://workspace-objects');
    vi.stubEnv('AWS_SESSION_TOKEN', 'session-token');

    await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);

    expect(injected.open).toHaveBeenCalledWith(expect.anything(), 'files', {
      credentials: {
        accessKeyId: 'access-key',
        secretAccessKey: 'secret-key',
        sessionToken: 'session-token',
      },
      createBucketIfMissing: false,
    });
  });

  it('does not create the bucket of an http endpoint', async () => {
    setStorageUrl('s3://workspace-objects?endpoint=http://seaweedfs.example.test');

    await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);
    await installSkillsApi(resolveWorkspace, scopes, catalog);

    for (const area of ['files', 'skills']) {
      expect(injected.open).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 's3', endpoint: 'http://seaweedfs.example.test' }),
        area,
        {
          credentials: { accessKeyId: 'access-key', secretAccessKey: 'secret-key' },
          createBucketIfMissing: false,
        },
      );
    }
  });

  // @story US-STO-10
  it('[US-STO-10][api][cli] preserves first-boot bucket creation for the bundled S3-compatible endpoint', async () => {
    setStorageUrl('s3://agent-workspace?endpoint=http://seaweedfs.example.test&pathStyle=true');
    vi.stubEnv('AW_STORAGE_CREATE_BUCKET', 'true');

    await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);
    await installSkillsApi(resolveWorkspace, scopes, catalog);
    await sessionStateBlobStore();

    for (const area of ['files', 'skills', 'session-state']) {
      expect(injected.open).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 's3', endpoint: 'http://seaweedfs.example.test' }),
        area,
        expect.objectContaining({ createBucketIfMissing: true }),
      );
    }
    expect(injected.openRoot).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 's3' }),
      expect.objectContaining({ createBucketIfMissing: true }),
    );
  });

  // @story US-STO-10
  it.each(['', 'false'])(
    '[US-STO-10][api][cli] AW_STORAGE_CREATE_BUCKET=%j never creates a bucket',
    async (value) => {
      setStorageUrl('s3://agent-workspace?endpoint=http://seaweedfs.example.test&pathStyle=true');
      vi.stubEnv('AW_STORAGE_CREATE_BUCKET', value);

      await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);
      await installSkillsApi(resolveWorkspace, scopes, catalog);

      expect(injected.open).toHaveBeenCalled();
      for (const [, , options] of injected.open.mock.calls) {
        expect(options?.createBucketIfMissing).toBe(false);
      }
    },
  );

  // @story US-STO-10
  it('[US-STO-10][api][cli] a malformed AW_STORAGE_CREATE_BUCKET stops start-up without echoing it', async () => {
    setStorageUrl('s3://agent-workspace');
    vi.stubEnv('AW_STORAGE_CREATE_BUCKET', 'yes-secret-value');

    const failure = installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);

    await expect(failure).rejects.toThrow('AW_STORAGE_CREATE_BUCKET must be true or false.');
    await expect(failure).rejects.not.toThrow('yes-secret-value');
    expect(injected.open).not.toHaveBeenCalled();
  });

  it('leaves both runtimes unconfigured when the container readiness check rejects', async () => {
    setStorageUrl('azblob://account/missing-container');
    injected.open.mockRejectedValue(new Error('missing container'));

    const files = await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);
    const skills = await installSkillsApi(resolveWorkspace, scopes, catalog);

    expect(files).toEqual({ kind: 'unavailable' });
    expect(skills).toEqual({ kind: 'unavailable' });
  });

  it('fails closed on an invalid AW_STORAGE_URL instead of falling through to local storage', async () => {
    setStorageUrl('typo://workspace-objects');

    const files = await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);
    const skills = await installSkillsApi(resolveWorkspace, scopes, catalog);

    expect(injected.open).not.toHaveBeenCalled();
    expect(files).toEqual({ kind: 'unavailable' });
    expect(skills).toEqual({ kind: 'unavailable' });
  });

  it('sessionStateBlobStore uses the session-state prefix on its bucket path', async () => {
    setStorageUrl('s3://workspace-objects');

    await expect(sessionStateBlobStore()).resolves.not.toBeNull();

    expect(injected.open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 's3', bucket: 'workspace-objects' }),
      'session-state',
      expect.anything(),
    );
  });

  // @story US-STO-10
  it('[US-STO-10][api][cli] an old setting alone installs nothing: no files, skills or session state', async () => {
    clearStorageEnvironment();
    vi.stubEnv('OBJECT_STORAGE_BACKEND', 's3');
    vi.stubEnv('OBJECT_STORAGE_BUCKET', 'workspace-objects');
    vi.stubEnv('AW_FILE_STORAGE_ROOT', '/srv/files');
    vi.stubEnv('AW_SESSION_TRANSCRIPT_ROOT', '/srv/sessions');

    const files = await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);
    const skills = await installSkillsApi(resolveWorkspace, scopes, catalog);
    const sessions = await sessionStateBlobStore();

    expect(injected.open).not.toHaveBeenCalled();
    expect(files).toEqual({ kind: 'unavailable' });
    expect(skills).toEqual({ kind: 'unavailable' });
    expect(sessions).toBeNull();
  });
});

function clearStorageEnvironment(): void {
  for (const name of [
    'AW_STORAGE_URL',
    'AW_FILE_STORAGE_ROOT',
    'AW_SKILL_STORAGE_ROOT',
    'AW_SESSION_TRANSCRIPT_ROOT',
    'OBJECT_STORAGE_BACKEND',
    'OBJECT_STORAGE_BUCKET',
    'OBJECT_STORAGE_ENDPOINT',
    'OBJECT_STORAGE_PUBLIC_ENDPOINT',
    'OBJECT_STORAGE_FORCE_PATH_STYLE',
    'AW_STORAGE_CREATE_BUCKET',
  ]) {
    vi.stubEnv(name, '');
  }
}

describe('AW_STORAGE_URL composition', () => {
  // @story US-STO-10
  it('[US-STO-10][api][cli] AW_STORAGE_URL alone installs files, skills and session-state', async () => {
    clearStorageEnvironment();
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'access-key');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret-key');
    vi.stubEnv('AWS_REGION', 'eu-west-1');
    vi.stubEnv('AW_STORAGE_URL', 's3://aw-bucket/p?endpoint=http://seaweedfs.example.test:8333');

    const files = await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);
    const skills = await installSkillsApi(resolveWorkspace, scopes, catalog);
    const sessions = await sessionStateBlobStore();

    const bucket = {
      kind: 's3',
      bucket: 'aw-bucket',
      prefix: 'p',
      endpoint: 'http://seaweedfs.example.test:8333',
      region: 'eu-west-1',
      forcePathStyle: false,
    };
    const options = {
      credentials: { accessKeyId: 'access-key', secretAccessKey: 'secret-key' },
      createBucketIfMissing: false,
    };
    for (const area of ['files', 'skills', 'session-state']) {
      expect(injected.open).toHaveBeenCalledWith(bucket, area, options);
    }
    expect([files.kind, skills.kind, sessions === null]).toEqual(['serving', 'serving', false]);

    injected.open.mockClear();
    vi.stubEnv('AW_STORAGE_URL', 'file:///srv/aw');
    await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);
    await installSkillsApi(resolveWorkspace, scopes, catalog);
    await sessionStateBlobStore();

    expect(injected.open.mock.calls.map(([location, area]) => [location, area])).toEqual([
      [{ kind: 'file', root: '/srv/aw/files' }, 'files'],
      [{ kind: 'file', root: '/srv/aw/skills' }, 'skills'],
      [{ kind: 'file', root: '/srv/aw/sessions' }, 'session-state'],
      [{ kind: 'file', root: '/srv/aw/skills' }, 'skills'],
      [{ kind: 'file', root: '/srv/aw/sessions' }, 'session-state'],
    ]);
  });

  // @story US-STO-10
  it('[US-STO-10][api][cli] an old setting beside AW_STORAGE_URL never moves or stops a store', async () => {
    clearStorageEnvironment();
    vi.stubEnv('AW_STORAGE_URL', 'file:///srv/aw');
    vi.stubEnv('AW_FILE_STORAGE_ROOT', '/elsewhere');

    const files = await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);
    const skills = await installSkillsApi(resolveWorkspace, scopes, catalog);
    const sessions = await sessionStateBlobStore();

    expect([files.kind, skills.kind, sessions === null]).toEqual(['serving', 'serving', false]);
    expect(logError).not.toHaveBeenCalled();
    expect(injected.open.mock.calls.map(([location]) => location)).not.toContainEqual({
      kind: 'file',
      root: '/elsewhere',
    });
  });

  // @story US-STO-10
  it('[US-STO-10][api][cli] storage warnings and refusals never echo a value', async () => {
    vi.resetModules();
    const { log: freshLog } = await import('../telemetry/logger');
    const info = vi.spyOn(freshLog, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(freshLog, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(freshLog, 'error').mockImplementation(() => undefined);
    const fresh = await import('./storage');
    const random = (): string => randomBytes(8).toString('hex');
    const secrets = {
      accessKey: ['AK', 'IA', random()].join(''),
      secretKey: random() + random(),
      clientId: randomUUID(),
      endpointHost: `${random()}.example.test`,
      urlHost: `${random()}.example.test`,
      root: `/${random()}`,
    };
    const logged = (): string =>
      JSON.stringify([info.mock.calls, warn.mock.calls, error.mock.calls]);
    const run = async (): Promise<void> => {
      await fresh.installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);
      await fresh.installSkillsApi(resolveWorkspace, scopes, catalog);
      await fresh.sessionStateBlobStore();
    };

    clearStorageEnvironment();
    vi.stubEnv('AWS_ACCESS_KEY_ID', secrets.accessKey);
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', secrets.secretKey);
    vi.stubEnv('AZURE_CLIENT_ID', secrets.clientId);
    vi.stubEnv('AW_PUBLIC_URL', 'https://aw.example.com');
    vi.stubEnv('OBJECT_STORAGE_BUCKET', 'aw-bucket');
    vi.stubEnv('OBJECT_STORAGE_ENDPOINT', `http://${secrets.endpointHost}`);
    await run();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[compose] storage_setting_ignored: ignoring OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_ENDPOINT; AW_STORAGE_URL alone says where files, skills and session state are kept (see .env.example). With AW_STORAGE_URL unset, nothing is read from the old location; files, skills and session state are off until AW_STORAGE_URL is set.',
    );
    expect(error).toHaveBeenCalledTimes(3);

    vi.stubEnv('AW_STORAGE_URL', `s3://other-bucket?endpoint=http://${secrets.urlHost}`);
    vi.stubEnv('AW_FILE_STORAGE_ROOT', secrets.root);
    await run();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(3);

    for (const value of Object.values(secrets)) expect(logged()).not.toContain(value);
  });
});

describe('AW_STORAGE_CREATE_BUCKET beside another scheme, and a refused URL', () => {
  // The warnings are logged once per process, so each case loads the module afresh.
  async function freshStorage() {
    vi.resetModules();
    const { log: freshLog } = await import('../telemetry/logger');
    const warn = vi.spyOn(freshLog, 'warn').mockImplementation(() => undefined);
    vi.spyOn(freshLog, 'info').mockImplementation(() => undefined);
    vi.spyOn(freshLog, 'error').mockImplementation(() => undefined);
    return { warn, storage: await import('./storage') };
  }

  // @story US-STO-10
  it('[US-STO-10][api][cli] warns once, without the value, that a file:// URL ignores AW_STORAGE_CREATE_BUCKET', async () => {
    const { warn, storage } = await freshStorage();
    clearStorageEnvironment();
    vi.stubEnv('AW_STORAGE_URL', 'file:///srv/aw');
    vi.stubEnv('AW_STORAGE_CREATE_BUCKET', 'true');

    const files = await storage.installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);
    await storage.installSkillsApi(resolveWorkspace, scopes, catalog);
    await storage.sessionStateBlobStore();

    expect(files.kind).toBe('serving');
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[compose] AW_STORAGE_CREATE_BUCKET applies only to an s3:// AW_STORAGE_URL, so it is ignored.',
    );
  });

  // @story US-STO-10
  it('[US-STO-10][api][cli] a refused AW_STORAGE_URL still reports the ignored old variables', async () => {
    const { warn, storage } = await freshStorage();
    clearStorageEnvironment();
    vi.stubEnv('AW_STORAGE_URL', 'typo://workspace-objects');
    vi.stubEnv('OBJECT_STORAGE_BUCKET', 'old-bucket');

    const files = await storage.installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);

    expect(files).toEqual({ kind: 'unavailable' });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[compose] storage_setting_ignored: ignoring OBJECT_STORAGE_BUCKET; AW_STORAGE_URL alone says where files, skills and session state are kept (see .env.example).',
    );
  });
});

describe('storage service composition', () => {
  // @story US-STO-01
  it('[US-STO-01][unit][sdk] the files runtime carries one storage service, built once', async () => {
    clearStorageEnvironment();
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'access-key');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret-key');
    vi.stubEnv('AWS_REGION', 'eu-west-1');
    vi.stubEnv('AW_STORAGE_URL', 's3://aw-bucket/p?endpoint=http://seaweedfs.example.test:8333');

    const files = await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);
    await installSkillsApi(resolveWorkspace, scopes, catalog);
    await sessionStateBlobStore();

    if (files.kind !== 'serving') throw new Error('the files API did not install');
    expect(files.runtime.storage).toBeDefined();
    expect(injected.openRoot).toHaveBeenCalledExactlyOnceWith(
      {
        kind: 's3',
        bucket: 'aw-bucket',
        prefix: 'p',
        endpoint: 'http://seaweedfs.example.test:8333',
        region: 'eu-west-1',
        forcePathStyle: false,
      },
      {
        credentials: { accessKeyId: 'access-key', secretAccessKey: 'secret-key' },
        createBucketIfMissing: false,
      },
    );
  });
});

describe('skills runtime storage service', () => {
  // @story US-STO-08
  it('[US-STO-08][unit][sdk] the skills runtime carries the storage service it is given, and none otherwise', async () => {
    setStorageUrl();
    const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
    const service = createStorageService({
      catalog: () => Promise.reject(new Error('unused')),
      objects: createInMemoryObjectStore(),
      log: noLog,
    });

    const withService = await installSkillsApi(resolveWorkspace, scopes, catalog, service);
    const without = await installSkillsApi(resolveWorkspace, scopes, catalog);

    if (withService.kind !== 'serving' || without.kind !== 'serving') {
      throw new Error('the skills API did not install');
    }
    expect(withService.runtime.storage).toBe(service);
    expect(without.runtime.storage).toBeUndefined();
  });
});

describe('storage service composition edge cases', () => {
  // @story US-STO-01
  it('[US-STO-01][unit][sdk] file:// roots the storage service at the storage folder', async () => {
    clearStorageEnvironment();
    vi.stubEnv('AW_STORAGE_URL', 'file:///srv/aw');

    await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);

    expect(injected.openRoot).toHaveBeenCalledExactlyOnceWith(
      { kind: 'file', root: '/srv/aw' },
      {},
    );
  });

  // @story US-STO-10
  it('[US-STO-10][api][cli] with AW_STORAGE_URL unset nothing is installed and each log line says why', async () => {
    clearStorageEnvironment();

    const files = await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);
    const skills = await installSkillsApi(resolveWorkspace, scopes, catalog);
    const sessions = await sessionStateBlobStore();

    expect([files, skills, sessions]).toEqual([
      { kind: 'unavailable' },
      { kind: 'unavailable' },
      null,
    ]);
    expect(injected.open).not.toHaveBeenCalled();
    expect(injected.openRoot).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      "[compose] files API NOT installed: AW_STORAGE_URL is unset or blank, and this deployment will not invent a directory to keep a workspace's files in. Every /api/files* route answers 503 files_runtime_not_configured.",
    );
    expect(logError).toHaveBeenCalledWith(
      '[compose] skills API NOT installed: AW_STORAGE_URL is unset or blank; every /api/skills* route answers 503 skills_runtime_not_configured.',
    );
    expect(logError).toHaveBeenCalledTimes(3);
  });

  // @story US-STO-01
  it('[US-STO-01][unit][sdk] a catalog service that cannot open leaves the files API unavailable and logs no provider text', async () => {
    setStorageUrl('s3://workspace-objects');
    const secret = randomBytes(8).toString('hex');
    injected.openRoot.mockRejectedValue(
      Object.assign(new Error(`https://${secret}.example.invalid refused`), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      }),
    );

    const files = await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);

    // There is no path-based fallback to serve from: the area store opened, the service did not.
    expect(files).toEqual({ kind: 'unavailable' });
    expect(logError).toHaveBeenCalledWith(
      '[compose] storage API NOT installed: object storage failed readiness (name=AccessDenied, status=403).',
    );
    expect(logError).toHaveBeenCalledWith(
      '[compose] files API NOT installed: the catalog service did not open. Every /api/files* route answers 503 files_runtime_not_configured.',
    );
    expect(JSON.stringify(logError.mock.calls)).not.toContain(secret);
  });
});

describe('every storage scheme installs the catalog service', () => {
  const schemes: ReadonlyArray<readonly [string, string]> = [
    ['file', 'file:///srv/aw'],
    ['s3', 's3://workspace-objects/p'],
    ['gcs', 'gcs://workspace-objects/p?project=demo'],
    ['azblob', 'azblob://account/workspace-objects'],
  ];

  // @story US-STO-01
  it.each(schemes)(
    '[US-STO-01][unit][sdk] %s:// installs files, skills and attachments runtimes that carry the catalog service',
    async (_scheme, url) => {
      setStorageUrl(url);

      const files = await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);
      if (files.kind !== 'serving') throw new Error('the files API did not install');
      const skills = await installSkillsApi(
        resolveWorkspace,
        scopes,
        catalog,
        files.runtime.storage,
      );

      if (skills.kind !== 'serving') throw new Error('the skills API did not install');
      const { storage } = files.runtime;
      if (storage === undefined) throw new Error('the files runtime carries no catalog service');
      expect(skills.runtime.storage).toBe(storage);
      // Chat attachments run on the files runtime: an upload needs its catalog service and
      // catalog, and the retention purge removes through the same service.
      expect(files.runtime.catalog).toBe(catalog);
      const remove = vi.spyOn(storage, 'remove').mockResolvedValue({ ok: true, removed: 1 });
      installTestDomains({ files });
      try {
        const workspaceId = randomUUID();
        const sessionId = randomUUID();
        expect(await purgeSessionAttachments(workspaceId, [sessionId])).toBe(1);
        expect(remove).toHaveBeenCalledWith(
          expect.objectContaining({ workspaceId }),
          'files',
          `.attachments/${sessionId}`,
          { recursive: true },
        );
      } finally {
        clearApplicationContext();
      }
      // The service sits on the mocked root; nothing here reached a real store.
      expect(injected.openRoot).toHaveBeenCalledTimes(1);
    },
  );

  // @story US-STO-10
  it('[US-STO-10][api][cli] with AW_STORAGE_URL unset the files and skills routes answer 503', async () => {
    clearStorageEnvironment();
    const files = await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);
    const skills = await installSkillsApi(resolveWorkspace, scopes, catalog);
    const workspaceId = randomUUID();
    installTestDomains({
      files,
      skills,
      rbac: {
        directory: createMemoryDirectory({
          users: [{ email: 'owner@example.test', name: 'Owner', workspaceId, role: 'owner' }],
        }),
        identify: () =>
          Promise.resolve(
            Principal.fromApiKey({
              principalId: randomUUID(),
              apiKeyId: randomUUID(),
              workspaceId,
              role: 'owner',
              label: 'Composition test key',
            }),
          ),
      },
    });
    try {
      const filesResponse = await listFilesRoute(new Request('https://example.invalid/api/files'));
      const skillsResponse = await listSkillsRoute(
        new Request('https://example.invalid/api/skills'),
      );

      expect(files).toEqual({ kind: 'unavailable' });
      expect(skills).toEqual({ kind: 'unavailable' });
      expect(filesResponse.status).toBe(503);
      expect(await filesResponse.json()).toMatchObject({
        error: { code: 'files_runtime_not_configured' },
      });
      expect(skillsResponse.status).toBe(503);
      expect(await skillsResponse.json()).toMatchObject({
        error: { code: 'skills_runtime_not_configured' },
      });
    } finally {
      clearApplicationContext();
    }
  });
});

describe('AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES', () => {
  const limitOf = async (): Promise<number | undefined> => {
    const files = await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts);
    return files.kind === 'serving' ? files.runtime.signedUploadMaxBytes : undefined;
  };

  it.each(['', '   '])('defaults to the hard maximum when unset or blank (%j)', async (blank) => {
    setStorageUrl();
    vi.stubEnv('AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES', blank);
    await expect(limitOf()).resolves.toBe(SIGNED_UPLOAD_HARD_MAX_BYTES);
  });

  it.each([
    ['1', 1],
    ['1073741824', 1_073_741_824],
    [String(SIGNED_UPLOAD_HARD_MAX_BYTES), SIGNED_UPLOAD_HARD_MAX_BYTES],
  ])('accepts %s on the local and the bucket runtime', async (value, bytes) => {
    vi.stubEnv('AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES', value);
    setStorageUrl();
    await expect(limitOf()).resolves.toBe(bytes);
    setStorageUrl('s3://workspace-objects');
    await expect(limitOf()).resolves.toBe(bytes);
  });

  it.each(['0', '-1', '1.5', '1e9', 'abc', String(SIGNED_UPLOAD_HARD_MAX_BYTES + 1)])(
    'refuses start-up on %j with a message that names only the variable',
    async (value) => {
      setStorageUrl();
      vi.stubEnv('AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES', value);
      const failure: unknown = await installFilesApi(
        resolveWorkspace,
        scopes,
        catalog,
        fileTexts,
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        `AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES must be a whole number of bytes from 1 to ${SIGNED_UPLOAD_HARD_MAX_BYTES}.`,
      );
    },
  );
});

describe('AW_STORAGE_CLEANUP', () => {
  // @story US-STO-14
  it('[US-STO-14][unit][sdk] an invalid AW_STORAGE_CLEANUP refuses start-up and is not echoed', async () => {
    setStorageUrl();
    vi.stubEnv('AW_STORAGE_CLEANUP', 'purge-everything');

    const failure: unknown = await installFilesApi(
      resolveWorkspace,
      scopes,
      catalog,
      fileTexts,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('AW_STORAGE_CLEANUP must be report or delete.');
  });

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] the hourly pass runs under the storage-cleanup lock in the configured mode', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      clearStorageEnvironment();
      vi.stubEnv('AWS_ACCESS_KEY_ID', 'access-key');
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret-key');
      vi.stubEnv('AWS_REGION', 'eu-west-1');
      vi.stubEnv('AW_STORAGE_URL', 's3://aw-bucket/p?endpoint=http://seaweedfs.example.test:8333');
      vi.stubEnv('AW_STORAGE_MIGRATE', 'off');
      vi.stubEnv('CRON_SECRET', '');
      vi.stubEnv('AW_STORAGE_CLEANUP', 'delete');
      const sessionState: DatabaseRoot['sessionState'] = {
        forScope: () => {
          throw new Error('the composition test lists no workspace');
        },
      };
      const locked: string[] = [];
      const lock = async <T>(name: string, work: () => Promise<T>) => {
        locked.push(name);
        return { acquired: true as const, value: await work() };
      };
      const stopOnClose = vi.fn<(stop: () => void) => void>();

      await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts, undefined, sessionState, {
        lock,
        workspaceIds: () => Promise.resolve([]),
        migrationRuns: createInMemoryStorageMigrationRuns(),
        stopOnClose,
      });
      await vi.waitFor(() =>
        expect(logInfo).toHaveBeenCalledWith(
          '[compose] storage cleanup scheduled hourly in delete mode (the storage design, §04).',
        ),
      );
      expect(stopOnClose).toHaveBeenCalledOnce();
      expect(locked).toEqual([]);

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(locked).toEqual(['storage-cleanup']);
      await vi.waitFor(() =>
        expect(logInfo).toHaveBeenCalledWith(
          'storage cleanup',
          expect.objectContaining({ mode: 'delete' }),
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AW_STORAGE_MIGRATE composition', () => {
  const owners = { ownerPrincipalId: () => Promise.resolve(null) };
  /** What adopt records its pass in; no other job starts without a session-state store. */
  const runLog = () => ({
    lock: <T>(_name: string, work: () => Promise<T>) =>
      work().then((value) => ({ acquired: true as const, value })),
    workspaceIds: () => Promise.resolve([]),
    migrationRuns: createInMemoryStorageMigrationRuns(),
    stopOnClose: () => undefined,
  });

  function useS3Root(): void {
    clearStorageEnvironment();
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'access-key');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret-key');
    vi.stubEnv('AWS_REGION', 'eu-west-1');
    vi.stubEnv('AW_STORAGE_URL', 's3://aw-bucket/p?endpoint=http://seaweedfs.example.test:8333');
  }

  // @story US-STO-13
  it('[US-STO-13][unit][cli] adopt runs in the background: start-up resolves while the listing is pending', async () => {
    useS3Root();
    vi.stubEnv('AW_STORAGE_MIGRATE', 'adopt');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = createInMemoryObjectStore();
    const listPage = vi.fn<ObjectStoreV2['listPage']>(async (prefix, options) => {
      await gate;
      return store.listPage(prefix, options);
    });
    injected.openRoot.mockResolvedValue({ ...store, listPage });

    const files = await installFilesApi(
      resolveWorkspace,
      scopes,
      catalog,
      fileTexts,
      owners,
      undefined,
      runLog(),
    );

    expect(files.kind).toBe('serving');
    await vi.waitFor(() =>
      expect(listPage).toHaveBeenCalledWith('files/workspaces', expect.anything()),
    );
    expect(logInfo).not.toHaveBeenCalledWith('[storage] adopted legacy files', expect.anything());
    release();
    await vi.waitFor(() =>
      expect(logInfo).toHaveBeenCalledWith('[storage] adopted legacy files', expect.anything()),
    );
  });

  // @story US-STO-13
  it('[US-STO-13][unit][cli] an unknown value starts nothing and is not echoed', async () => {
    useS3Root();
    vi.stubEnv('AW_STORAGE_MIGRATE', 'purge-everything');
    const listPage = vi.fn<ObjectStoreV2['listPage']>();
    injected.openRoot.mockResolvedValue({ ...createInMemoryObjectStore(), listPage });

    await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts, owners);

    expect(logError).toHaveBeenCalledTimes(1);
    const message = String(logError.mock.calls[0]?.[0]);
    expect(message).toContain('AW_STORAGE_MIGRATE');
    expect(message).not.toContain('purge-everything');
    expect(listPage).not.toHaveBeenCalled();
  });

  // @story US-STO-13
  it('[US-STO-13][unit][cli] unset starts adopt in the background', async () => {
    useS3Root();
    vi.stubEnv('AW_STORAGE_MIGRATE', '');
    const listPage = vi.fn<ObjectStoreV2['listPage']>();
    injected.openRoot.mockResolvedValue({ ...createInMemoryObjectStore(), listPage });
    listPage.mockResolvedValue({ entries: [], cursor: null });

    await installFilesApi(
      resolveWorkspace,
      scopes,
      catalog,
      fileTexts,
      owners,
      undefined,
      runLog(),
    );

    await vi.waitFor(() =>
      expect(listPage).toHaveBeenCalledWith('files/workspaces', expect.anything()),
    );
    expect(logError).not.toHaveBeenCalled();
  });

  // @story US-STO-13
  it('[US-STO-13][unit][cli] off starts nothing', async () => {
    useS3Root();
    vi.stubEnv('AW_STORAGE_MIGRATE', 'off');
    const listPage = vi.fn<ObjectStoreV2['listPage']>();
    injected.openRoot.mockResolvedValue({ ...createInMemoryObjectStore(), listPage });

    await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts, owners);

    expect(listPage).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  async function installWithLock(mode: string) {
    useS3Root();
    vi.stubEnv('AW_STORAGE_MIGRATE', mode);
    vi.stubEnv('CRON_SECRET', '');
    const listPage = vi.fn<ObjectStoreV2['listPage']>();
    listPage.mockResolvedValue({ entries: [], cursor: null });
    injected.openRoot.mockResolvedValue({ ...createInMemoryObjectStore(), listPage });
    const locked: string[] = [];
    const lock = async <T>(name: string, work: () => Promise<T>) => {
      locked.push(name);
      return { acquired: true as const, value: await work() };
    };
    await installFilesApi(resolveWorkspace, scopes, catalog, fileTexts, owners, undefined, {
      lock,
      workspaceIds: () => Promise.resolve([]),
      migrationRuns: createInMemoryStorageMigrationRuns(),
      stopOnClose: () => undefined,
    });
    return { listPage, locked };
  }

  const finalProgress = () =>
    logInfo.mock.calls.some(
      ([message]) =>
        typeof message === 'string' &&
        message.startsWith('{') &&
        (JSON.parse(message) as { done?: boolean }).done === true,
    );

  // @story US-STO-13
  it('[US-STO-13][unit][cli] copy adopts, then copies under the storage-migrate lock', async () => {
    const { listPage, locked } = await installWithLock('copy');

    await vi.waitFor(() => expect(finalProgress()).toBe(true));
    expect(listPage).toHaveBeenCalledWith('files/workspaces', expect.anything());
    expect(locked).toContain('storage-migrate');
    expect(logError).not.toHaveBeenCalled();
  });

  // @story US-STO-13
  it('[US-STO-13][unit][cli] copy-dry-run counts without adopting', async () => {
    const { listPage, locked } = await installWithLock('copy-dry-run');

    await vi.waitFor(() => expect(finalProgress()).toBe(true));
    expect(listPage).not.toHaveBeenCalled();
    expect(locked).toContain('storage-migrate');
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('"mode":"copy-dry-run"'));
  });

  // @story US-STO-13
  it('[US-STO-13][unit][cli] finalize adopts, then checks and records under the storage-migrate lock', async () => {
    const { listPage, locked } = await installWithLock('finalize');

    await vi.waitFor(() =>
      expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('"verify":{')),
    );
    expect(listPage).toHaveBeenCalledWith('files/workspaces', expect.anything());
    expect(locked).toContain('storage-migrate');
    expect(logError).not.toHaveBeenCalled();
  });

  type Lock = <T>(
    name: string,
    work: () => Promise<T>,
  ) => Promise<{ readonly acquired: true; readonly value: T } | { readonly acquired: false }>;

  /** Install the skills API with the skills adopt wiring; `workspaceIds` runs only inside the pass. */
  async function installSkillsWithAdopt(
    lock: Lock,
    workspaceIds: () => Promise<readonly string[]> = () => Promise.resolve([]),
  ) {
    const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
    const service = createStorageService({
      catalog: () => Promise.reject(new Error('unused')),
      objects: createInMemoryObjectStore(),
      log: noLog,
    });
    return installSkillsApi(resolveWorkspace, scopes, catalog, service, {
      lock,
      workspaceIds,
      migrationRuns: createInMemoryStorageMigrationRuns(),
      owners,
    });
  }

  function recordingLock() {
    const locked: string[] = [];
    const lock: Lock = async (name, work) => {
      locked.push(name);
      return { acquired: true, value: await work() };
    };
    return { lock, locked };
  }

  // @story US-STO-13
  it.each(['', 'adopt', 'copy', 'finalize'])(
    '[US-STO-13][unit][cli] AW_STORAGE_MIGRATE=%s runs the skills adopt at start-up under its lock',
    async (mode) => {
      useS3Root();
      vi.stubEnv('AW_STORAGE_MIGRATE', mode);
      const { lock, locked } = recordingLock();
      const workspaceIds = vi.fn(() => Promise.resolve([]));

      await installSkillsWithAdopt(lock, workspaceIds);

      await vi.waitFor(() =>
        expect(logInfo).toHaveBeenCalledWith('[storage] adopted legacy skills', expect.anything()),
      );
      expect(locked).toEqual(['storage-migrate-skills']);
      expect(workspaceIds).toHaveBeenCalledTimes(1);
    },
  );

  // @story US-STO-13
  it.each(['off', 'copy-dry-run'])(
    '[US-STO-13][unit][cli] AW_STORAGE_MIGRATE=%s does not run the skills adopt',
    async (mode) => {
      useS3Root();
      vi.stubEnv('AW_STORAGE_MIGRATE', mode);
      const { lock, locked } = recordingLock();

      const skills = await installSkillsWithAdopt(lock);
      await vi.dynamicImportSettled();

      expect(skills.kind).toBe('serving');
      expect(locked).toEqual([]);
      expect(logInfo).not.toHaveBeenCalledWith(
        '[storage] adopted legacy skills',
        expect.anything(),
      );
    },
  );

  // @story US-STO-13
  it('[US-STO-13][unit][cli] two servers starting together run the skills adopt once', async () => {
    useS3Root();
    vi.stubEnv('AW_STORAGE_MIGRATE', 'adopt');
    // One lock shared by both servers: it tries once and never waits, like the advisory lock.
    let held = false;
    const lock: Lock = async (_name, work) => {
      if (held) return { acquired: false };
      held = true;
      try {
        return { acquired: true, value: await work() };
      } finally {
        held = false;
      }
    };
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    const workspaceIds = vi.fn(async () => {
      await released;
      return [];
    });

    await installSkillsWithAdopt(lock, workspaceIds);
    await vi.waitFor(() => expect(workspaceIds).toHaveBeenCalledTimes(1));
    await installSkillsWithAdopt(lock, workspaceIds);
    await vi.waitFor(() =>
      expect(logInfo).toHaveBeenCalledWith('skills adopt skipped: another server is running it'),
    );
    release();

    await vi.waitFor(() =>
      expect(logInfo).toHaveBeenCalledWith('[storage] adopted legacy skills', expect.anything()),
    );
    expect(workspaceIds).toHaveBeenCalledTimes(1);
  });
});
