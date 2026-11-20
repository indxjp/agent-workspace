import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import {
  clearStorageEnvironment,
  deps,
  fileTexts,
  injected,
  installFiles,
  installSkills,
  setStorageUrl,
  useS3Root,
  useStorageTestHooks,
} from './storage.test-support';
import { storageReadinessFailure } from './storage';

vi.mock('@agent-workspace/core/storage', async (original) => ({
  ...(await original<typeof import('@agent-workspace/core/storage')>()),
  openObjectStore: (...args: Parameters<typeof injected.open>) => injected.open(...args),
  openRootObjectStore: (...args: Parameters<typeof injected.openRoot>) =>
    injected.openRoot(...args),
}));

const logs = useStorageTestHooks();

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

    const files = await installFiles();
    const skills = await installSkills();

    const azure = {
      kind: 'azblob',
      account: 'account',
      serviceUrl: 'https://account.blob.core.windows.net',
      container: 'workspace-objects',
      prefix: '',
    };
    const options = { managedIdentityClientId: '11111111-1111-1111-1111-111111111111' };
    expect(injected.open).toHaveBeenCalledTimes(2);
    expect(injected.open).toHaveBeenNthCalledWith(1, azure, 'files', options);
    expect(injected.open).toHaveBeenNthCalledWith(2, azure, 'skills', options);
    expect(files.kind).toBe('serving');
    expect(skills.kind).toBe('serving');
  });

  it('never creates a bucket named by an S3 URL', async () => {
    setStorageUrl('s3://workspace-objects');

    await installFiles();
    await installSkills();

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

    await installFiles();

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

    await installFiles();
    await installSkills();

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
});

describe('AW_STORAGE_CREATE_BUCKET on an s3:// URL', () => {
  // @story US-STO-10
  it('[US-STO-10][api][cli] preserves first-boot bucket creation for the bundled S3-compatible endpoint', async () => {
    setStorageUrl('s3://agent-workspace?endpoint=http://seaweedfs.example.test&pathStyle=true');
    vi.stubEnv('AW_STORAGE_CREATE_BUCKET', 'true');

    await installFiles();
    await installSkills();

    for (const area of ['files', 'skills']) {
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

      await installFiles();
      await installSkills();

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

    const failure = installFiles();

    await expect(failure).rejects.toThrow('AW_STORAGE_CREATE_BUCKET must be true or false.');
    await expect(failure).rejects.not.toThrow('yes-secret-value');
    expect(injected.open).not.toHaveBeenCalled();
  });
});

describe('storage that is unconfigured or refused', () => {
  it('leaves both runtimes unconfigured when the container readiness check rejects', async () => {
    setStorageUrl('azblob://account/missing-container');
    injected.open.mockRejectedValue(new Error('missing container'));

    const files = await installFiles();
    const skills = await installSkills();

    expect(files).toEqual({ kind: 'unavailable' });
    expect(skills).toEqual({ kind: 'unavailable' });
  });

  it('fails closed on an invalid AW_STORAGE_URL instead of falling through to local storage', async () => {
    setStorageUrl('typo://workspace-objects');

    const files = await installFiles();
    const skills = await installSkills();

    expect(injected.open).not.toHaveBeenCalled();
    expect(files).toEqual({ kind: 'unavailable' });
    expect(skills).toEqual({ kind: 'unavailable' });
  });

  // @story US-STO-10
  it('[US-STO-10][api][cli] an old setting alone installs nothing: no files or skills', async () => {
    clearStorageEnvironment();
    vi.stubEnv('OBJECT_STORAGE_BACKEND', 's3');
    vi.stubEnv('OBJECT_STORAGE_BUCKET', 'workspace-objects');
    vi.stubEnv('AW_FILE_STORAGE_ROOT', '/srv/files');
    vi.stubEnv('AW_SESSION_TRANSCRIPT_ROOT', '/srv/sessions');

    const files = await installFiles();
    const skills = await installSkills();

    expect(injected.open).not.toHaveBeenCalled();
    expect(files).toEqual({ kind: 'unavailable' });
    expect(skills).toEqual({ kind: 'unavailable' });
  });
});

describe('AW_STORAGE_URL composition', () => {
  // @story US-STO-10
  it('[US-STO-10][api][cli] AW_STORAGE_URL alone installs files and skills', async () => {
    useS3Root();

    const files = await installFiles();
    const skills = await installSkills();

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
    for (const area of ['files', 'skills']) {
      expect(injected.open).toHaveBeenCalledWith(bucket, area, options);
    }
    expect([files.kind, skills.kind]).toEqual(['serving', 'serving']);

    injected.open.mockClear();
    vi.stubEnv('AW_STORAGE_URL', 'file:///srv/aw');
    await installFiles();
    await installSkills();

    expect(injected.open.mock.calls.map(([location, area]) => [location, area])).toEqual([
      [{ kind: 'file', root: '/srv/aw/files' }, 'files'],
      [{ kind: 'file', root: '/srv/aw/skills' }, 'skills'],
    ]);
  });

  // @story US-STO-10
  it('[US-STO-10][api][cli] an old setting beside AW_STORAGE_URL never moves or stops a store', async () => {
    clearStorageEnvironment();
    vi.stubEnv('AW_STORAGE_URL', 'file:///srv/aw');
    vi.stubEnv('AW_FILE_STORAGE_ROOT', '/elsewhere');

    const files = await installFiles();
    const skills = await installSkills();

    expect([files.kind, skills.kind]).toEqual(['serving', 'serving']);
    expect(logs.error()).not.toHaveBeenCalled();
    expect(injected.open.mock.calls.map(([location]) => location)).not.toContainEqual({
      kind: 'file',
      root: '/elsewhere',
    });
  });
});

describe('AW_STORAGE_URL logging', () => {
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
      await fresh.installFilesApi(deps, fileTexts);
      await fresh.installSkillsApi(deps);
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
    expect(error).toHaveBeenCalledTimes(2);

    vi.stubEnv('AW_STORAGE_URL', `s3://other-bucket?endpoint=http://${secrets.urlHost}`);
    vi.stubEnv('AW_FILE_STORAGE_ROOT', secrets.root);
    await run();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(2);

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

    const files = await storage.installFilesApi(deps, fileTexts);
    await storage.installSkillsApi(deps);

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

    const files = await storage.installFilesApi(deps, fileTexts);

    expect(files).toEqual({ kind: 'unavailable' });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[compose] storage_setting_ignored: ignoring OBJECT_STORAGE_BUCKET; AW_STORAGE_URL alone says where files, skills and session state are kept (see .env.example).',
    );
  });
});
