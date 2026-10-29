/**
 * `importing core/storage loads no cloud SDK` — the storage design, §02 ("each cloud's library is
 * loaded only when that cloud is used"), checked the only way that proves it: a fresh Node process
 * over the built `dist/`, with a resolve hook recording every specifier Node is asked to load.
 * `index.test.ts` walks source and runs under Vitest, so it cannot say what a server loads.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openObjectStore, openRootObjectStore } from './open.js';
import { readWhole } from './streams.js';

const backends = vi.hoisted(() => ({
  s3: vi.fn(() => Promise.resolve({ kind: 's3' })),
  gcs: vi.fn(() => Promise.resolve({ kind: 'gcs' })),
  azure: vi.fn(() => Promise.resolve({ kind: 'azure' })),
}));
vi.mock('./s3-store.js', () => ({ createS3ObjectStoreFromConfig: backends.s3 }));
vi.mock('./gcs-store.js', () => ({ createGcsObjectStoreFromConfig: backends.gcs }));
vi.mock('./azure-blob-store.js', () => ({
  createAzureBlobObjectStoreFromConfig: backends.azure,
}));

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(here, '../../dist/storage/index.js');
const MARKER = 'SPECIFIERS:';

const RECORD_SPECIFIERS = `
import { registerHooks } from 'node:module';
const seen = new Set();
registerHooks({
  resolve(specifier, context, nextResolve) {
    seen.add(specifier);
    return nextResolve(specifier, context);
  },
});
process.on('exit', () => process.stderr.write('\\n${MARKER}' + JSON.stringify([...seen]) + '\\n'));
`;

function specifiersLoadedBy(entry: string): string[] {
  if (!existsSync(entry)) {
    throw new Error(
      `${entry} does not exist. Run \`pnpm --filter @agent-workspace/core run build\` before ` +
        '`pnpm test`; this test imports the compiled barrel exactly as a server does.',
    );
  }
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      `data:text/javascript,${encodeURIComponent(RECORD_SPECIFIERS)}`,
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(pathToFileURL(entry).href)})`,
    ],
    { encoding: 'utf8' },
  );
  const line = result.stderr.split('\n').find((candidate) => candidate.startsWith(MARKER));
  if (result.status !== 0 || line === undefined) {
    throw new Error(`Importing ${entry} failed (status ${result.status}):\n${result.stderr}`);
  }
  const parsed: unknown = JSON.parse(line.slice(MARKER.length));
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`Unexpected specifier list from ${entry}: ${line}`);
  }
  return parsed;
}

describe('the storage barrel loads no cloud SDK', () => {
  it('importing core/storage loads no cloud SDK', () => {
    const cloud = specifiersLoadedBy(distEntry).filter((specifier) =>
      /^@(aws-sdk|azure|google-cloud)\//u.test(specifier),
    );
    expect(cloud).toEqual([]);
  });
});

describe('openObjectStore', () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('openObjectStore file:// returns a local provider', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'open-object-store-'));
    roots.push(root);
    const provider = await openObjectStore({ kind: 'file', root }, 'files');
    const store = provider.forWorkspace('w1');
    await store.write('a.txt', new TextEncoder().encode('hello'), {});
    const read = await readWhole(store, 'a.txt');
    expect(new TextDecoder().decode(read?.body)).toBe('hello');
    for (const backend of Object.values(backends)) expect(backend).not.toHaveBeenCalled();
  });

  it('openObjectStore s3 loads only the S3 file', async () => {
    await openObjectStore(
      { kind: 's3', bucket: 'bucket-a', prefix: '', forcePathStyle: false },
      'files',
      {
        credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
        createBucketIfMissing: true,
      },
    );
    expect(backends.s3).toHaveBeenCalledExactlyOnceWith({
      bucket: 'bucket-a',
      region: 'us-east-1',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      forcePathStyle: false,
      createBucketIfMissing: true,
      keyPrefix: 'files',
    });
    expect(backends.gcs).not.toHaveBeenCalled();
    expect(backends.azure).not.toHaveBeenCalled();
  });

  it('openObjectStore s3 passes the session token of temporary credentials', async () => {
    await openObjectStore(
      { kind: 's3', bucket: 'bucket-a', prefix: '', forcePathStyle: false },
      'files',
      { credentials: { accessKeyId: 'id', secretAccessKey: 'secret', sessionToken: 'token' } },
    );
    expect(backends.s3).toHaveBeenCalledWith(
      expect.objectContaining({
        accessKeyId: 'id',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      }),
    );
  });

  it('openObjectStore puts the location prefix before the area', async () => {
    await openObjectStore(
      {
        kind: 's3',
        bucket: 'bucket-a',
        prefix: 'tenant-a',
        endpoint: 'http://localhost:9000',
        region: 'eu-west-1',
        forcePathStyle: true,
      },
      'skills',
    );
    expect(backends.s3).toHaveBeenCalledExactlyOnceWith({
      bucket: 'bucket-a',
      region: 'eu-west-1',
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
      keyPrefix: 'tenant-a/skills',
    });
  });

  it('openObjectStore maps gcs and azblob locations', async () => {
    await openObjectStore(
      { kind: 'gcs', bucket: 'bucket-g', prefix: '', projectId: 'proj' },
      'session-state',
      { timeoutMs: 5_000 },
    );
    expect(backends.gcs).toHaveBeenCalledExactlyOnceWith({
      bucket: 'bucket-g',
      keyPrefix: 'session-state',
      projectId: 'proj',
      timeoutMs: 5_000,
    });
    await openObjectStore(
      {
        kind: 'azblob',
        account: 'acct',
        serviceUrl: 'https://acct.blob.core.windows.net',
        container: 'cont',
        prefix: 'p',
      },
      'files',
      { managedIdentityClientId: 'mi' },
    );
    expect(backends.azure).toHaveBeenCalledExactlyOnceWith({
      serviceUrl: 'https://acct.blob.core.windows.net',
      container: 'cont',
      keyPrefix: 'p/files',
      managedIdentityClientId: 'mi',
    });
    expect(backends.s3).not.toHaveBeenCalled();
  });
});

describe('openRootObjectStore', () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('openRootObjectStore roots each bucket backend at the location prefix, not an area', async () => {
    await openRootObjectStore({ kind: 's3', bucket: 'b', prefix: 'p', forcePathStyle: false });
    expect(backends.s3).toHaveBeenCalledExactlyOnceWith({
      bucket: 'b',
      region: 'us-east-1',
      forcePathStyle: false,
      keyPrefix: 'p',
    });
    await openRootObjectStore({ kind: 'gcs', bucket: 'g', prefix: '' });
    expect(backends.gcs).toHaveBeenCalledExactlyOnceWith({ bucket: 'g', keyPrefix: '' });
    await openRootObjectStore({
      kind: 'azblob',
      account: 'acct',
      serviceUrl: 'https://acct.blob.core.windows.net',
      container: 'cont',
      prefix: 'p/q',
    });
    expect(backends.azure).toHaveBeenCalledExactlyOnceWith({
      serviceUrl: 'https://acct.blob.core.windows.net',
      container: 'cont',
      keyPrefix: 'p/q',
    });
  });

  it('openRootObjectStore file:// is the root directory itself', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'open-root-object-store-'));
    roots.push(root);
    const store = await openRootObjectStore({ kind: 'file', root });
    await store.write('workspaces/w/files/x', new TextEncoder().encode('hi'), {});
    const scoped = (await openObjectStore({ kind: 'file', root }, 'files')).forWorkspace('w');
    expect(new TextDecoder().decode((await readWhole(scoped, 'files/x'))?.body)).toBe('hi');
  });
});
