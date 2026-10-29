import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  FILE_STORAGE_ROOT_ENV,
  IGNORED_STORAGE_VARIABLES,
  OBJECT_STORAGE_BACKEND_ENV,
  OBJECT_STORAGE_BUCKET_ENV,
  SESSION_STATE_STORAGE_ROOT_ENV,
  SKILL_STORAGE_ROOT_ENV,
  configuredObjectStorageBackend,
  ignoredStorageSettingsWarning,
  ignoredStorageVariables,
  legacyAreaPrefixes,
  legacyStorageVariables,
  resolveStorageSettings,
  storageAreaPlace,
  storageUrlReplacing,
  type LegacyLocalRoots,
  type ObjectStorageBackend,
  type ResolvePath,
  type StorageSettings,
} from './storage-settings.js';
import type { StorageLocation } from './storage-url.js';

// @story US-STO-10
describe('storage settings: the old variables are ignored', () => {
  it('[US-STO-10][unit][cli] lists the old variables that are set, not blank ones', () => {
    expect(
      ignoredStorageVariables({
        OBJECT_STORAGE_BUCKET: 'b',
        OBJECT_STORAGE_BACKEND: ' ',
        AW_STORAGE_URL: 's3://b',
      }),
    ).toEqual(['OBJECT_STORAGE_BUCKET']);
  });

  it('[US-STO-10][unit][cli] the warning names each variable and AW_STORAGE_URL', () => {
    const warning = ignoredStorageSettingsWarning({
      AW_FILE_STORAGE_ROOT: '/srv/files',
      OBJECT_STORAGE_BUCKET: 'b',
      AW_STORAGE_URL: 's3://b',
    });

    expect(warning).toBe(
      'storage_setting_ignored: ignoring AW_FILE_STORAGE_ROOT, OBJECT_STORAGE_BUCKET; AW_STORAGE_URL alone says where files, skills and session state are kept (see .env.example).',
    );
    expect(ignoredStorageSettingsWarning({ AW_STORAGE_URL: 's3://b' })).toBeNull();
  });

  it('[US-STO-10][unit][cli] with AW_STORAGE_URL unset the warning says storage is off', () => {
    expect(ignoredStorageSettingsWarning({ OBJECT_STORAGE_BUCKET: 'b', AW_STORAGE_URL: ' ' })).toBe(
      'storage_setting_ignored: ignoring OBJECT_STORAGE_BUCKET; AW_STORAGE_URL alone says where files, skills and session state are kept (see .env.example). With AW_STORAGE_URL unset, nothing is read from the old location; files, skills and session state are off until AW_STORAGE_URL is set.',
    );
  });

  it('[US-STO-10][unit][cli] a refused AW_STORAGE_URL still carries the ignored-variables warning', () => {
    const settings = resolveStorageSettings({
      AW_STORAGE_URL: 'typo://b',
      AW_FILE_STORAGE_ROOT: '/srv/files',
    });

    expect(settings.kind).toBe('refused');
    // #1746: the code is a field, not only the start of the reason.
    expect(settings).toMatchObject({ code: 'storage_url_invalid' });
    expect(settings.warnings).toEqual([
      'storage_setting_ignored: ignoring AW_FILE_STORAGE_ROOT; AW_STORAGE_URL alone says where files, skills and session state are kept (see .env.example).',
    ]);
    expect(storageAreaPlace(settings, 'files')).toEqual({
      kind: 'refused',
      reason: settings.kind === 'refused' ? settings.reason : '',
    });
  });

  it('[US-STO-10][unit][cli] one warning for every old variable set, with no value in it', () => {
    // Built at runtime so the file holds no key-shaped literal.
    const secret = ['AK', 'IA'].join('') + globalThis.crypto.randomUUID();
    const env = Object.fromEntries(IGNORED_STORAGE_VARIABLES.map((name) => [name, secret]));

    const settings = resolveStorageSettings(env);

    expect(settings.kind).toBe('none');
    if (settings.kind !== 'none') return;
    expect(settings.warnings).toEqual([ignoredStorageSettingsWarning(env)]);
    expect(settings.warnings[0]).toContain(IGNORED_STORAGE_VARIABLES.join(', '));
    expect(JSON.stringify(settings)).not.toContain(secret);
  });

  it('[US-STO-10][unit][cli] the old variables never change the place AW_STORAGE_URL names', () => {
    const url = {
      AW_PUBLIC_URL: 'https://aw.example.com',
      AW_STORAGE_URL: 's3://agent-workspace?endpoint=http://seaweedfs:8333&pathStyle=true',
    };
    const old = {
      OBJECT_STORAGE_BUCKET: 'another-bucket',
      OBJECT_STORAGE_BACKEND: 'gcs',
      OBJECT_STORAGE_PUBLIC_ENDPOINT: 'http://localhost:8333',
      AW_FILE_STORAGE_ROOT: '/srv/files',
    };

    const settings = resolveStorageSettings({ ...old, ...url });

    expect(settings.kind).toBe('url');
    if (settings.kind !== 'url') return;
    expect(settings.warnings).toHaveLength(1);
    expect({ ...settings, warnings: [] }).toEqual(resolveStorageSettings(url));
  });

  it('[US-STO-10][unit][cli] with only an old variable there is no place', () => {
    const settings = resolveStorageSettings({ AW_FILE_STORAGE_ROOT: '/srv/files' });

    expect(storageAreaPlace(settings, 'files')).toEqual({ kind: 'unset' });
    expect(storageAreaPlace(settings, 'skills')).toEqual({ kind: 'unset' });
  });
});

// @story US-STO-13
describe('storage settings: the old object layouts', () => {
  const prefixesOf = (env: Record<string, string>) =>
    legacyAreaPrefixes(resolveStorageSettings(env)).map(({ area, prefix }) => [area, prefix]);

  it('[US-STO-13][unit][cli] a file URL keeps each area in its own directory', () => {
    expect(prefixesOf({ AW_STORAGE_URL: 'file:///srv/aw' })).toEqual([
      ['files', 'files/workspaces'],
      ['skills', 'skills/workspaces'],
      ['session-state', 'sessions/workspaces'],
    ]);
    const [files] = legacyAreaPrefixes(
      resolveStorageSettings({ AW_STORAGE_URL: 'file:///srv/aw' }),
    );
    expect(files?.location).toEqual({ kind: 'file', root: '/srv/aw' });
  });

  it('[US-STO-13][unit][cli] a bucket keeps each area under its own key prefix', () => {
    expect(prefixesOf({ AW_STORAGE_URL: 's3://aw-bucket?region=us-east-1' })).toEqual([
      ['files', 'files/workspaces'],
      ['skills', 'skills/workspaces'],
      ['session-state', 'session-state/workspaces'],
    ]);
  });

  it('[US-STO-13][unit][cli] unset, ignored and refused settings have no old layout', () => {
    expect(prefixesOf({})).toEqual([]);
    expect(prefixesOf({ AW_FILE_STORAGE_ROOT: '/srv/f', OBJECT_STORAGE_BUCKET: 'b' })).toEqual([]);
    expect(prefixesOf({ AW_STORAGE_URL: 'ftp://nowhere' })).toEqual([]);
  });
});

// @story US-STO-10
// storage-bridge(#1944): the 0.6.10 exports stay as deprecated shims until the next major release
describe('storage settings: the deprecated 0.6.10 exports', () => {
  const roots = (over: Partial<LegacyLocalRoots> = {}): LegacyLocalRoots => ({
    kind: 'local-roots',
    files: '/srv/aw/files',
    skills: '/srv/aw/skills',
    sessionState: '/srv/aw/sessions',
    filesAndSkillsRefusal: null,
    ...over,
  });

  it('[US-STO-10][unit][cli] the 0.6.10 usages still compile', () => {
    expectTypeOf<typeof FILE_STORAGE_ROOT_ENV>().toEqualTypeOf<'AW_FILE_STORAGE_ROOT'>();
    expectTypeOf<typeof SKILL_STORAGE_ROOT_ENV>().toEqualTypeOf<'AW_SKILL_STORAGE_ROOT'>();
    expectTypeOf<
      typeof SESSION_STATE_STORAGE_ROOT_ENV
    >().toEqualTypeOf<'AW_SESSION_TRANSCRIPT_ROOT'>();
    expectTypeOf<typeof OBJECT_STORAGE_BACKEND_ENV>().toEqualTypeOf<'OBJECT_STORAGE_BACKEND'>();
    expectTypeOf<typeof OBJECT_STORAGE_BUCKET_ENV>().toEqualTypeOf<'OBJECT_STORAGE_BUCKET'>();
    expectTypeOf<ObjectStorageBackend>().toEqualTypeOf<'s3' | 'gcs' | 'azure-blob'>();
    expectTypeOf<ResolvePath>().toEqualTypeOf<(path: string) => string>();
    expectTypeOf(
      configuredObjectStorageBackend,
    ).returns.toEqualTypeOf<ObjectStorageBackend | null>();
    expectTypeOf(legacyStorageVariables).returns.toEqualTypeOf<string[]>();
    expectTypeOf(storageUrlReplacing)
      .parameter(0)
      .toEqualTypeOf<StorageLocation | LegacyLocalRoots>();
    expectTypeOf(storageUrlReplacing).returns.toEqualTypeOf<string | null>();
    expectTypeOf(resolveStorageSettings).returns.toExtend<StorageSettings>();
    const none: StorageSettings = { kind: 'none' };
    const refused: StorageSettings = { kind: 'refused', reason: 'x' };

    const resolve: ResolvePath = (path) => path;
    const settings = resolveStorageSettings({}, resolve);
    const describeKind = (value: StorageSettings): string => {
      switch (value.kind) {
        case 'legacy': {
          const location: StorageLocation | LegacyLocalRoots = value.location;
          return location.kind;
        }
        case 'url':
          return value.location.kind;
        case 'none':
          return 'none';
        case 'refused':
          return value.reason;
        default: {
          const unreachable: never = value;
          return unreachable;
        }
      }
    };
    expect(describeKind(settings)).toBe('none');
    expect(settings.kind === 'legacy').toBe(false);
    expect([describeKind(none), describeKind(refused)]).toEqual(['none', 'x']);
  });

  it('[US-STO-10][unit][cli] each constant keeps its 0.6.10 value', () => {
    expect([
      FILE_STORAGE_ROOT_ENV,
      SKILL_STORAGE_ROOT_ENV,
      SESSION_STATE_STORAGE_ROOT_ENV,
      OBJECT_STORAGE_BACKEND_ENV,
      OBJECT_STORAGE_BUCKET_ENV,
    ]).toEqual([
      'AW_FILE_STORAGE_ROOT',
      'AW_SKILL_STORAGE_ROOT',
      'AW_SESSION_TRANSCRIPT_ROOT',
      'OBJECT_STORAGE_BACKEND',
      'OBJECT_STORAGE_BUCKET',
    ]);
  });

  it('[US-STO-10][unit][cli] configuredObjectStorageBackend reads the variable as before', () => {
    expect(configuredObjectStorageBackend({})).toBeNull();
    expect(configuredObjectStorageBackend({ OBJECT_STORAGE_BACKEND: '  ' })).toBeNull();
    for (const backend of ['s3', 'gcs', 'azure-blob'] as const) {
      expect(configuredObjectStorageBackend({ OBJECT_STORAGE_BACKEND: ` ${backend} ` })).toBe(
        backend,
      );
    }
    expect(() => configuredObjectStorageBackend({ OBJECT_STORAGE_BACKEND: 'nfs' })).toThrow(
      'OBJECT_STORAGE_BACKEND must be s3, gcs, or azure-blob.',
    );
  });

  it('[US-STO-10][unit][cli] legacyStorageVariables is ignoredStorageVariables', () => {
    const env = {
      AW_FILE_STORAGE_ROOT: '/srv/files',
      OBJECT_STORAGE_BUCKET: 'b',
      OBJECT_STORAGE_BACKEND: ' ',
      AW_STORAGE_URL: 's3://b',
    };

    expect(legacyStorageVariables(env)).toEqual(['AW_FILE_STORAGE_ROOT', 'OBJECT_STORAGE_BUCKET']);
    expect(legacyStorageVariables(env)).toEqual(ignoredStorageVariables(env));
  });

  it.each([
    {
      name: 'a file URL with an old root set',
      env: { AW_STORAGE_URL: 'file:///srv/aw', AW_FILE_STORAGE_ROOT: '/old' },
    },
    { name: 'nothing set', env: {} },
  ])(
    '[US-STO-10][unit][cli] resolveStorageSettings ignores the resolve argument: $name',
    ({ env }) => {
      const resolve = vi.fn((path: string) => path);

      expect(resolveStorageSettings(env, resolve)).toEqual(resolveStorageSettings(env));
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it('[US-STO-10][unit][cli] a hand-built legacy value places and lists nothing', () => {
    const legacy: StorageSettings = {
      kind: 'legacy',
      location: { kind: 'file', root: '/srv/aw' },
      warnings: [],
    };

    expect(storageAreaPlace(legacy, 'files')).toEqual({ kind: 'unset' });
    expect(legacyAreaPrefixes(legacy)).toEqual([]);
  });

  describe('storageUrlReplacing', () => {
    const s3: StorageLocation = {
      kind: 's3',
      bucket: 'acme',
      prefix: '',
      region: 'us-east-1',
      forcePathStyle: false,
    };

    it('[US-STO-10][unit][cli] roots that share a parent give a file URL', () => {
      expect(storageUrlReplacing(roots(), {})).toBe('file:///srv/aw');
    });

    it.each([
      { name: 'roots without a shared parent', location: roots({ skills: '/srv/b/skills' }) },
      { name: 'a refusal on files and skills', location: roots({ filesAndSkillsRefusal: 'no' }) },
      {
        name: 'an azure service URL with no account',
        location: {
          kind: 'azblob',
          account: '',
          serviceUrl: 'https://blob.example',
          container: 'c',
          prefix: '',
        } satisfies StorageLocation,
      },
    ])('[US-STO-10][unit][cli] gives no URL for $name', ({ location }) => {
      expect(storageUrlReplacing(location, {})).toBeNull();
    });

    it('[US-STO-10][unit][cli] an s3 bucket keeps its region unless AWS_REGION is set', () => {
      expect(storageUrlReplacing(s3, {})).toContain('region=us-east-1');
      expect(storageUrlReplacing(s3, { AWS_REGION: 'eu-west-1' })).toBe('s3://acme');
    });

    it('[US-STO-10][unit][cli] a gcs bucket gives a gcs URL', () => {
      expect(
        storageUrlReplacing({ kind: 'gcs', bucket: 'acme', prefix: '', projectId: 'p' }, {}),
      ).toBe('gcs://acme?project=p');
    });
  });
});
