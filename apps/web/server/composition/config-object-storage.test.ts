import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { openObjectStore } from '@agent-workspace/core/storage';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveStorageSettings, storageAreaPlace, type StorageArea } from './config';

const AREAS: readonly StorageArea[] = ['files', 'skills', 'session-state'];

/** Where the bytes of one area end up: backend, bucket or root, and the effective key prefix. */
function placeOf(env: Record<string, string>, area: StorageArea): string {
  const place = storageAreaPlace(resolveStorageSettings(env), area);
  if (place.kind !== 'at') return place.kind;
  const { location } = place;
  const keyPrefix = (prefix: string): string => (prefix === '' ? area : `${prefix}/${area}`);
  switch (location.kind) {
    case 'file':
      return `file ${path.resolve(location.root)}`;
    case 's3':
      return `s3 ${location.bucket}/${keyPrefix(location.prefix)} ${location.endpoint ?? ''}`;
    case 'gcs':
      return `gcs ${location.bucket}/${keyPrefix(location.prefix)}`;
    case 'azblob':
      return `azblob ${location.serviceUrl} ${location.container}/${keyPrefix(location.prefix)}`;
  }
}

const embeddedRoot = path.resolve('.agent-workspace/storage');

/** The eight old location variables the resolver ignores, by name. */
const OLD_VARIABLES = [
  'AW_FILE_STORAGE_ROOT',
  'AW_SKILL_STORAGE_ROOT',
  'AW_SESSION_TRANSCRIPT_ROOT',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_BACKEND',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_PUBLIC_ENDPOINT',
  'OBJECT_STORAGE_FORCE_PATH_STYLE',
] as const;

describe('AW_STORAGE_URL and the old storage settings', () => {
  // @story US-STO-10
  it('[US-STO-10][api][cli] an old storage setting is ignored with a warning pointing to AW_STORAGE_URL', () => {
    // Built at runtime so the file holds no key-shaped literal.
    const secret = ['AK', 'IA'].join('') + randomUUID();

    for (const name of OLD_VARIABLES) {
      const alone = resolveStorageSettings({ [name]: secret });
      const withUrl = resolveStorageSettings({
        AW_STORAGE_URL: 'file:///srv/aw',
        [name]: secret,
      });

      expect(alone.kind).toBe('none');
      expect(withUrl.kind).toBe('url');
      for (const settings of [alone, withUrl]) {
        if (settings.kind === 'refused') throw new Error(`${name} must not refuse`);
        expect(settings.warnings).toHaveLength(1);
        expect(settings.warnings[0]).toContain('storage_setting_ignored');
        expect(settings.warnings[0]).toContain(name);
        expect(settings.warnings[0]).toContain('AW_STORAGE_URL');
        expect(JSON.stringify(settings)).not.toContain(secret);
      }
    }

    const together = resolveStorageSettings(
      Object.fromEntries(OLD_VARIABLES.map((name) => [name, secret])),
    );
    expect(together.kind).toBe('none');
    if (together.kind !== 'none') return;
    expect(together.warnings).toHaveLength(1);
    for (const name of OLD_VARIABLES) expect(together.warnings[0]).toContain(name);
    expect(JSON.stringify(together)).not.toContain(secret);
  });

  // @story US-STO-10
  it('[US-STO-10][api][cli] an old setting that names another place than AW_STORAGE_URL never stops start-up', () => {
    const settings = resolveStorageSettings({
      AW_STORAGE_URL: 'file:///srv/aw',
      AW_FILE_STORAGE_ROOT: '/elsewhere',
      OBJECT_STORAGE_BUCKET: 'other-bucket',
      OBJECT_STORAGE_BACKEND: 'typo',
    });

    expect(settings).toMatchObject({ kind: 'url', location: { kind: 'file', root: '/srv/aw' } });
    for (const area of AREAS) {
      expect(storageAreaPlace(settings, area)).toMatchObject({
        kind: 'at',
        location: { kind: 'file' },
      });
    }
  });

  // @story US-STO-10
  it('[US-STO-10][api][cli] without AW_STORAGE_URL an old setting names no place', () => {
    const settings = resolveStorageSettings({
      AW_FILE_STORAGE_ROOT: '/var/lib/agent-workspace/files',
      OBJECT_STORAGE_BUCKET: 'aw-bucket',
    });

    for (const area of AREAS) {
      expect(storageAreaPlace(settings, area)).toEqual({ kind: 'unset' });
    }
  });

  // @story US-STO-10
  it.each([
    {
      name: 'compose-local',
      url: 'file:///var/lib/agent-workspace',
      places: [
        'file /var/lib/agent-workspace/files',
        'file /var/lib/agent-workspace/skills',
        'file /var/lib/agent-workspace/sessions',
      ],
    },
    {
      name: 'compose-SeaweedFS',
      url: 's3://agent-workspace?endpoint=http://seaweedfs:8333&pathStyle=true',
      places: [
        's3 agent-workspace/files http://seaweedfs:8333',
        's3 agent-workspace/skills http://seaweedfs:8333',
        's3 agent-workspace/session-state http://seaweedfs:8333',
      ],
    },
    {
      name: 'AWS',
      url: 's3://aw-bucket?region=eu-west-1',
      places: ['s3 aw-bucket/files ', 's3 aw-bucket/skills ', 's3 aw-bucket/session-state '],
    },
    {
      name: 'R2',
      url: 's3://aw-bucket?endpoint=https://acct.r2.cloudflarestorage.com',
      places: [
        's3 aw-bucket/files https://acct.r2.cloudflarestorage.com',
        's3 aw-bucket/skills https://acct.r2.cloudflarestorage.com',
        's3 aw-bucket/session-state https://acct.r2.cloudflarestorage.com',
      ],
    },
    {
      name: 'GCS',
      url: 'gcs://aw-bucket?project=aw-project',
      places: ['gcs aw-bucket/files', 'gcs aw-bucket/skills', 'gcs aw-bucket/session-state'],
    },
    {
      name: 'Azure',
      url: 'azblob://account/aw-container',
      places: [
        'azblob https://account.blob.core.windows.net aw-container/files',
        'azblob https://account.blob.core.windows.net aw-container/skills',
        'azblob https://account.blob.core.windows.net aw-container/session-state',
      ],
    },
    {
      name: 'embedded',
      url: pathToFileURL(embeddedRoot).href,
      places: [
        `file ${embeddedRoot}/files`,
        `file ${embeddedRoot}/skills`,
        `file ${embeddedRoot}/sessions`,
      ],
    },
  ])('$name: AW_STORAGE_URL resolves to the area places', (row) => {
    for (const [index, area] of AREAS.entries()) {
      expect(placeOf({ AW_STORAGE_URL: row.url }, area)).toBe(row.places[index]);
    }
  });

  // @story US-STO-10
  it('refuses an invalid AW_STORAGE_URL without echoing it', () => {
    const secret = randomBytes(8).toString('hex');
    const urls = [`s3://user:${secret}@aw-bucket`, `ftp://${secret}`, `s3://aw-bucket?k=${secret}`];
    for (const url of urls) {
      const settings = resolveStorageSettings({ AW_STORAGE_URL: url });
      expect(settings.kind).toBe('refused');
      expect(JSON.stringify(settings)).not.toContain(secret);
      expect(JSON.stringify(settings)).toContain('AW_STORAGE_URL');
    }
  });

  // @story US-STO-10
  it('[US-STO-10][api][cli] with no storage setting at all nothing is stored and nothing is warned', () => {
    const unset = resolveStorageSettings({ AWS_REGION: 'eu-west-1' });

    expect(unset).toEqual({ kind: 'none', warnings: [] });
    for (const area of AREAS) expect(storageAreaPlace(unset, area)).toEqual({ kind: 'unset' });
    expect(resolveStorageSettings({ AW_STORAGE_URL: 'file:///srv/aw' })).toEqual({
      kind: 'url',
      location: { kind: 'file', root: '/srv/aw' },
      warnings: [],
    });
  });
});

describe('upgrading to AW_STORAGE_URL', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  // @story US-STO-13
  it('[US-STO-13][api][cli] an install keeps reading the files of its old per-area roots after setting the equivalent AW_STORAGE_URL', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aw-upgrade-'));
    directory = root;
    const directories: Record<StorageArea, string> = {
      files: 'files',
      skills: 'skills',
      'session-state': 'sessions',
    };

    for (const area of AREAS) {
      const text = `bytes of ${area}`;
      const written = await openObjectStore(
        { kind: 'file', root: path.join(root, directories[area]) },
        area,
      );
      await written
        .forWorkspace('upgrade-test')
        .put('kept.txt', { body: new TextEncoder().encode(text) });

      const place = storageAreaPlace(
        resolveStorageSettings({ AW_STORAGE_URL: pathToFileURL(root).href }),
        area,
      );
      if (place.kind !== 'at') throw new Error(`no place for ${area}`);
      const afterUpgrade = await (
        await openObjectStore(place.location, area)
      )
        .forWorkspace('upgrade-test')
        .get('kept.txt');

      expect(new TextDecoder().decode(afterUpgrade?.body)).toBe(text);
    }
  });
});

describe("a storage endpoint on the app's own origin", () => {
  const publicUrl = 'https://aw.example.com';

  // @story US-STO-05
  it.each([
    {
      name: 'a path-only proxy',
      env: { AW_STORAGE_URL: 's3://aw-bucket/p?endpoint=https://aw.example.com/s3' },
      source: 'AW_STORAGE_URL',
    },
    {
      name: 'an upper-case host with the default port spelled out',
      env: { AW_STORAGE_URL: 's3://aw-bucket?endpoint=https://AW.Example.com:443' },
      source: 'AW_STORAGE_URL',
    },
    {
      name: 'an Azure service URL under a path',
      env: { AW_STORAGE_URL: 'azblob://account/aw-container?endpoint=https://aw.example.com/blob' },
      source: 'AW_STORAGE_URL',
    },
    {
      name: 'a public endpoint on the app origin',
      env: {
        AW_STORAGE_URL:
          's3://aw-bucket?endpoint=http://seaweedfs:8333&publicEndpoint=https://aw.example.com',
      },
      source: 'AW_STORAGE_URL',
    },
    {
      name: 'a virtual-hosted bucket on the app host',
      env: {
        AW_PUBLIC_URL: 'https://aw-bucket.example.com',
        AW_STORAGE_URL: 's3://aw-bucket?endpoint=https://example.com',
      },
      source: 'AW_STORAGE_URL',
    },
  ])(
    "[US-STO-05][api][sdk] a storage endpoint on the app's own origin is refused: $name",
    ({ env, source }) => {
      const settings = resolveStorageSettings({ AW_PUBLIC_URL: publicUrl, ...env });

      expect(settings.kind).toBe('refused');
      if (settings.kind !== 'refused') return;
      expect(settings.reason).toMatch(/^storage_endpoint_same_origin/u);
      expect(settings.reason).toContain(source);
      expect(settings.reason).toContain('AW_PUBLIC_URL');
      expect(settings.reason).not.toContain('example');
    },
  );

  // @story US-STO-05
  it('[US-STO-05][api][sdk] origins are compared after IDN normalisation', () => {
    const settings = resolveStorageSettings({
      AW_PUBLIC_URL: 'https://bücher.example',
      AW_STORAGE_URL: 's3://aw-bucket?endpoint=https://xn--bcher-kva.example',
    });

    expect(settings.kind).toBe('refused');
  });

  // @story US-STO-05
  it.each([
    { name: 'a sub-domain', url: 's3://aw-bucket?endpoint=https://s3.aw.example.com' },
    { name: 'another port', url: 's3://aw-bucket?endpoint=https://aw.example.com:8443' },
    { name: 'another scheme', url: 's3://aw-bucket?endpoint=http://aw.example.com' },
    { name: 'a private host', url: 's3://aw-bucket?endpoint=http://seaweedfs:8333' },
    { name: 'no endpoint', url: 's3://aw-bucket' },
    {
      name: 'a public endpoint on the loopback',
      url: 's3://aw-bucket?endpoint=http://seaweedfs:8333&publicEndpoint=http://localhost:8333',
    },
  ])('[US-STO-05][api][sdk] an endpoint on another origin is allowed: $name', ({ url }) => {
    const settings = resolveStorageSettings({
      AW_PUBLIC_URL: publicUrl,
      AW_STORAGE_URL: url,
    });

    expect(settings.kind).toBe('url');
  });

  // @story US-STO-05
  it('[US-STO-05][api][sdk] without AW_PUBLIC_URL an endpoint is not refused and a warning says so', () => {
    const settings = resolveStorageSettings({
      AW_STORAGE_URL: 's3://aw-bucket?endpoint=http://seaweedfs:8333',
    });

    expect(settings.kind).toBe('url');
    if (settings.kind !== 'url') return;
    expect(settings.warnings).toHaveLength(1);
    expect(settings.warnings[0]).toContain('AW_PUBLIC_URL');
    expect(settings.warnings[0]).not.toContain('seaweedfs');

    const withoutEndpoint = resolveStorageSettings({ AW_STORAGE_URL: 's3://aw-bucket' });
    expect(withoutEndpoint).toMatchObject({ kind: 'url', warnings: [] });
  });
});
