/**
 * The local-filesystem half of the ObjectStore contract suite (W2-plan.md's first acceptance
 * criterion), plus the assertions specific to this backend that the shared suite in `contract.ts`
 * cannot make because they are about the real filesystem underneath it.
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  defineObjectStoreContract,
  defineOwnPagingContract,
  type ObjectStoreContractFixture,
} from './contract.js';
import { OBJECT_METADATA_SUFFIX } from './key-safety.js';
import { createLocalFilesystemObjectStoreProvider } from './local-fs-store.js';
import { readWhole } from './streams.js';

async function setup(): Promise<ObjectStoreContractFixture> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-03-objectstore-'));
  return {
    provider: createLocalFilesystemObjectStoreProvider(rootDir),
    teardown: () => rm(rootDir, { recursive: true, force: true }),
    async plantRaw(key, bytes) {
      const target = path.join(rootDir, 'objects', ...key.split('/'));
      if (key.endsWith('/')) {
        await mkdir(target, { recursive: true });
        return;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    },
  };
}

defineObjectStoreContract('local filesystem', setup);
defineOwnPagingContract('local filesystem', setup);

describe('local-filesystem ObjectStore — backend-specific proof', () => {
  const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';

  function scopedStore(rootDir: string) {
    return createLocalFilesystemObjectStoreProvider(rootDir).forWorkspace(WORKSPACE_ID);
  }

  it('never creates a file outside rootDir, even when the guard is the only thing standing between the key and node:fs', async () => {
    // A dedicated parent directory, not the shared OS tmpdir: other sessions and agents run
    // concurrently against the same machine (the wave protocol says so explicitly), and a
    // generic filename could already exist there for a reason that has nothing to do with this
    // test. The escape target's name is also unique per run, so a stray leftover from a prior,
    // interrupted run of this same test cannot be mistaken for evidence either way.
    const isolationParent = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-03-objectstore-escape-'));
    const rootDir = path.join(isolationParent, 'root');
    const nonce = `escaped-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
    try {
      const store = scopedStore(rootDir);
      const attacks = [`../${nonce}`, `/${nonce}`, `..%2f${encodeURIComponent(nonce)}`];
      for (const key of attacks) {
        await expect(store.write(key, new Uint8Array([1, 2, 3]), {})).rejects.toThrow();
      }
      // Positive proof, not just "it threw": nothing appeared anywhere in the isolated parent
      // (which "../<nonce>" from inside rootDir would land in) or inside rootDir itself.
      const siblingEntries = await readdir(isolationParent);
      expect(siblingEntries).not.toContain(nonce);
      const ownEntries = await readdir(rootDir, { recursive: true } as never).catch(() => []);
      expect(ownEntries).toEqual([]);
    } finally {
      await rm(isolationParent, { recursive: true, force: true });
    }
  });

  it('cannot hold a file and a folder at the same key (why this store declares fileAndFolderShareKey: false)', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-03-objectstore-dup-'));
    try {
      const store = scopedStore(rootDir);
      await store.write('dup/x', new TextEncoder().encode('file'), {});
      await expect(store.write('dup/x/y', new TextEncoder().encode('deep'), {})).rejects.toThrow();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('stores the object as real bytes on disk under a workspace-id subdirectory of the object tree', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-03-objectstore-onDisk-'));
    try {
      const store = scopedStore(rootDir);
      await store.write('a/b.txt', new TextEncoder().encode('hi'), {});
      const objectDir = path.join(rootDir, 'objects', 'workspaces', WORKSPACE_ID);
      const entries = await readdir(objectDir, { recursive: true } as never);
      expect(entries).toContain(path.join('a', 'b.txt'));
      // The metadata tree mirrors the shape, one directory over.
      const metadataEntries = await readdir(
        path.join(rootDir, 'metadata', 'workspaces', WORKSPACE_ID),
        { recursive: true } as never,
      );
      expect(metadataEntries).toContain(path.join('a', `b.txt${OBJECT_METADATA_SUFFIX}`));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('two writes of the same size with the same mtime still get different etags', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aw-fs-etag-'));
    const onDisk = path.join(rootDir, 'objects', 'workspaces', WORKSPACE_ID, 'k.txt');
    const sameTime = new Date('2026-01-01T00:00:00.000Z');
    try {
      const store = scopedStore(rootDir);
      await store.write('k.txt', new TextEncoder().encode('aaaa'), {});
      await utimes(onDisk, sameTime, sameTime);
      const first = await store.head('k.txt');
      await store.write('k.txt', new TextEncoder().encode('bbbb'), {});
      await utimes(onDisk, sameTime, sameTime);
      const second = await store.head('k.txt');
      expect(second?.etag).not.toBe(first?.etag);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('a failed body leaves neither the object nor a staging file, and the previous version stays readable', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aw-fs-failed-write-'));
    const failingBody = (): ReadableStream<Uint8Array> => {
      let pulls = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls > 2) controller.error(new Error('body failed'));
          else controller.enqueue(new Uint8Array(1024));
        },
      });
    };
    try {
      const store = scopedStore(rootDir);
      await store.write('k.txt', new TextEncoder().encode('original'), {});

      await expect(store.write('k.txt', failingBody(), {})).rejects.toThrow('body failed');
      await expect(store.write('fresh.txt', failingBody(), {})).rejects.toThrow('body failed');

      expect(await readdir(path.join(rootDir, 'staging'))).toEqual([]);
      expect(await readdir(path.join(rootDir, 'objects', 'workspaces', WORKSPACE_ID))).toEqual([
        'k.txt',
      ]);
      const kept = await readWhole(store, 'k.txt');
      expect(new TextDecoder().decode(kept?.body)).toBe('original');
      expect(await store.head('fresh.txt')).toBeNull();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
