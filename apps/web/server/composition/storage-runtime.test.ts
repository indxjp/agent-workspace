import { randomBytes, randomUUID } from 'node:crypto';

import type { DatabaseRoot } from '@agent-workspace/core/db';
import { describe, expect, it, vi } from 'vitest';
import { SIGNED_UPLOAD_HARD_MAX_BYTES } from '@indx-workspace/contracts/files';
import { GET as listFilesRoute } from '../../app/api/files/route';
import { GET as listSkillsRoute } from '../../app/api/skills/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { purgeSessionAttachments } from '../surfaces/public/attachments';
import { installFilesApi, installSkillsApi } from './storage';
import {
  catalog,
  clearStorageEnvironment,
  createUnusedStorageService,
  deps,
  fileTexts,
  injected,
  installFiles,
  installSkills,
  setStorageUrl,
  useS3Root,
  useStorageTestHooks,
} from './storage.test-support';

vi.mock('@agent-workspace/core/storage', async (original) => ({
  ...(await original<typeof import('@agent-workspace/core/storage')>()),
  openObjectStore: (...args: Parameters<typeof injected.open>) => injected.open(...args),
  openRootObjectStore: (...args: Parameters<typeof injected.openRoot>) =>
    injected.openRoot(...args),
}));

const logs = useStorageTestHooks();

describe('storage service composition', () => {
  // @story US-STO-01
  it('[US-STO-01][unit][sdk] the files runtime carries one storage service, built once', async () => {
    useS3Root();

    const files = await installFiles();
    await installSkills();

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

describe('skills area opened once', () => {
  // @story US-STO-08
  it('[US-STO-08][unit][sdk] the skills area is opened once, by the skills runtime', async () => {
    setStorageUrl('azblob://account/workspace-objects');

    const files = await installFiles();
    if (files.kind !== 'serving') throw new Error('the files API did not install');
    const skills = await installSkillsApi(deps, files.runtime.storage);

    expect(skills.kind).toBe('serving');
    expect(injected.open.mock.calls.map(([, area]) => area)).toEqual(['files', 'skills']);
  });
});

describe('skills runtime storage service', () => {
  // @story US-STO-08
  it('[US-STO-08][unit][sdk] the skills runtime carries the storage service it is given, and none otherwise', async () => {
    setStorageUrl();
    const service = createUnusedStorageService();

    const withService = await installSkillsApi(deps, service);
    const without = await installSkills();

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

    await installFiles();

    expect(injected.openRoot).toHaveBeenCalledExactlyOnceWith(
      { kind: 'file', root: '/srv/aw' },
      {},
    );
  });

  // @story US-STO-10
  it('[US-STO-10][api][cli] with AW_STORAGE_URL unset nothing is installed and each log line says why', async () => {
    clearStorageEnvironment();

    const files = await installFiles();
    const skills = await installSkills();

    expect([files, skills]).toEqual([{ kind: 'unavailable' }, { kind: 'unavailable' }]);
    expect(injected.open).not.toHaveBeenCalled();
    expect(injected.openRoot).not.toHaveBeenCalled();
    expect(logs.error()).toHaveBeenCalledWith(
      "[compose] files API NOT installed: AW_STORAGE_URL is unset or blank, and this deployment will not invent a directory to keep a workspace's files in. Every /api/files* route answers 503 files_runtime_not_configured.",
    );
    expect(logs.error()).toHaveBeenCalledWith(
      '[compose] skills API NOT installed: AW_STORAGE_URL is unset or blank; every /api/skills* route answers 503 skills_runtime_not_configured.',
    );
    expect(logs.error()).toHaveBeenCalledTimes(2);
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

    const files = await installFiles();

    // There is no path-based fallback to serve from: the area store opened, the service did not.
    expect(files).toEqual({ kind: 'unavailable' });
    expect(logs.error()).toHaveBeenCalledWith(
      '[compose] storage API NOT installed: object storage failed readiness (name=AccessDenied, status=403).',
    );
    expect(logs.error()).toHaveBeenCalledWith(
      '[compose] files API NOT installed: the catalog service did not open. Every /api/files* route answers 503 files_runtime_not_configured.',
    );
    expect(JSON.stringify(logs.error().mock.calls)).not.toContain(secret);
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

      const files = await installFiles();
      if (files.kind !== 'serving') throw new Error('the files API did not install');
      const skills = await installSkillsApi(deps, files.runtime.storage);

      if (skills.kind !== 'serving') throw new Error('the skills API did not install');
      const { storage } = files.runtime;
      if (storage === undefined) throw new Error('the files runtime carries no catalog service');
      expect(skills.runtime.storage).toBe(storage);
      // Chat attachments run on the files runtime: an upload needs its catalog service and
      // catalog, and the retention purge removes through the same service.
      expect(files.runtime.catalog).toBe(catalog);
      const remove = vi
        .spyOn(storage, 'remove')
        .mockResolvedValue({ ok: true, removed: 1, files: [] });
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
});

describe('storage routes without AW_STORAGE_URL', () => {
  // @story US-STO-10
  it('[US-STO-10][api][cli] with AW_STORAGE_URL unset the files and skills routes answer 503', async () => {
    clearStorageEnvironment();
    const files = await installFiles();
    const skills = await installSkills();
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
    const files = await installFiles();
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
      const failure: unknown = await installFilesApi(deps, fileTexts).catch(
        (error: unknown) => error,
      );
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

    const failure: unknown = await installFilesApi(deps, fileTexts).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('AW_STORAGE_CLEANUP must be report or delete.');
  });

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] the hourly pass runs under the storage-cleanup lock in the configured mode', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      useS3Root();
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

      await installFilesApi(deps, fileTexts, sessionState, {
        lock,
        workspaceIds: () => Promise.resolve([]),
        stopOnClose,
      });
      await vi.waitFor(() =>
        expect(logs.info()).toHaveBeenCalledWith(
          '[compose] storage cleanup scheduled hourly in delete mode (the storage design, §04).',
        ),
      );
      expect(stopOnClose).toHaveBeenCalledOnce();
      expect(locked).toEqual([]);

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(locked).toEqual(['storage-cleanup']);
      await vi.waitFor(() =>
        expect(logs.info()).toHaveBeenCalledWith(
          'storage cleanup',
          expect.objectContaining({ mode: 'delete' }),
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
