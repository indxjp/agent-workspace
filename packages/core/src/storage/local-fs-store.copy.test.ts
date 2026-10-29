/**
 * `copy` on the local-filesystem backend is staged and renamed into place, as `write` is. These
 * cases inject a fault into the byte copy itself, so they live apart from `local-fs-store.test.ts`:
 * the module mocks below would otherwise sit under the whole contract suite.
 *
 * The injection covers both ways the bytes can move: a stream into a staging file, and
 * `copyFile` straight onto the destination (what `copy` did before it staged). Either way, a
 * failure happens after some bytes are written, and a pause holds the copy half done.
 */
import type { WriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLocalFilesystemObjectStore } from './local-fs-store.js';
import type { ObjectStore } from './object-store.js';
import { streamToBytes } from './streams.js';

type Fault =
  | { readonly kind: 'none' }
  | { readonly kind: 'fail' }
  | { readonly kind: 'pause'; readonly reached: () => void; readonly gate: Promise<void> };

// Hoisted with the mocks below, which run before this file's own imports and declarations.
const fault = vi.hoisted(() => {
  const state = {
    current: { kind: 'none' } as Fault,
    enospc: (): Error => Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }),
    /** Take the armed fault, once: the next byte copy gets it and later ones run normally. */
    take: (): Fault => {
      const taken = state.current;
      state.current = { kind: 'none' };
      return taken;
    },
  };
  return state;
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { Writable } = await import('node:stream');
  /** Writes the first chunk for real, then fails or waits, as the armed fault says. */
  class FaultyWriteStream extends Writable {
    #first = true;
    constructor(
      private readonly inner: WriteStream,
      private readonly armed: Fault,
    ) {
      super();
    }
    override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error) => void) {
      this.inner.write(chunk, (error) => {
        if (error) return done(error);
        const first = this.#first;
        this.#first = false;
        if (!first) return done();
        if (this.armed.kind === 'fail') return done(fault.enospc());
        if (this.armed.kind === 'pause') {
          this.armed.reached();
          void this.armed.gate.then(() => done());
          return;
        }
        done();
      });
    }
    override _final(done: (error?: Error) => void) {
      this.inner.end(() => done());
    }
    override _destroy(error: Error | null, done: (error?: Error | null) => void) {
      this.inner.destroy();
      done(error);
    }
  }
  return {
    ...actual,
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
      const inner = actual.createWriteStream(...args);
      const armed = fault.take();
      return armed.kind === 'none' ? inner : new FaultyWriteStream(inner, armed);
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    copyFile: async (from: string, to: string, mode?: number) => {
      const armed = fault.take();
      if (armed.kind === 'none') return actual.copyFile(from, to, mode);
      // What an in-place copy leaves when it stops part way: a truncated destination.
      const bytes = await actual.readFile(from);
      await actual.writeFile(to, bytes.subarray(0, bytes.byteLength / 2));
      if (armed.kind === 'fail') throw fault.enospc();
      armed.reached();
      await armed.gate;
      await actual.writeFile(to, bytes);
    },
  };
});

const SIZE = 256 * 1024; // several read chunks, so the fault lands mid-copy
const filled = (byte: number): Uint8Array => new Uint8Array(SIZE).fill(byte);
/** Length and distinct byte values: enough to tell old, new and partial apart, and cheap to diff. */
const shape = (bytes: Uint8Array | null) =>
  bytes === null ? null : { size: bytes.byteLength, values: [...new Set(bytes)].sort() };

const roots: string[] = [];

afterEach(async () => {
  fault.current = { kind: 'none' };
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openStore(): Promise<{ root: string; store: ObjectStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aw-local-copy-'));
  roots.push(root);
  return { root, store: createLocalFilesystemObjectStore(root) };
}

async function bytesAt(store: ObjectStore, key: string): Promise<Uint8Array | null> {
  const read = await store.read(key);
  return read === null ? null : streamToBytes(read.body);
}

async function stagingEntries(root: string): Promise<string[]> {
  return readdir(path.join(root, 'staging')).catch(() => []);
}

describe('local filesystem copy is staged and renamed into place', () => {
  it('a copy that fails part way leaves no destination and no staging file', async () => {
    const { root, store } = await openStore();
    await store.write('source.bin', filled(0x62), {});
    fault.current = { kind: 'fail' };

    await expect(store.copy('source.bin', 'dest.bin')).rejects.toMatchObject({ code: 'ENOSPC' });

    expect(await store.head('dest.bin')).toBeNull();
    expect(await stagingEntries(root)).toEqual([]);
    expect(shape(await bytesAt(store, 'source.bin'))).toEqual(shape(filled(0x62)));
  });

  it('a read during a copy sees the old bytes or the new ones, never part of either', async () => {
    const { root, store } = await openStore();
    await store.write('dest.bin', filled(0x61), {});
    await store.write('source.bin', filled(0x62), {});
    let reached!: () => void;
    const halfway = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fault.current = { kind: 'pause', reached, gate };

    const copying = store.copy('source.bin', 'dest.bin');
    await halfway;
    let midway: Uint8Array | null;
    try {
      midway = await bytesAt(store, 'dest.bin');
    } finally {
      release(); // also on a failed read, so the paused copy never outlives the test
    }
    await copying;
    expect(shape(midway)).toEqual(shape(filled(0x61)));

    expect(shape(await bytesAt(store, 'dest.bin'))).toEqual(shape(filled(0x62)));
    expect(await stagingEntries(root)).toEqual([]);
  });

  it('a symlinked source is copied exactly as read serves it', async () => {
    // `read` follows a symlink planted inside `objects/` (the module header declares this), so
    // `copy` must agree with it rather than apply a policy of its own.
    const { root, store } = await openStore();
    const outside = path.join(root, 'outside.txt');
    await writeFile(outside, 'outside');
    await mkdir(path.join(root, 'objects'), { recursive: true });
    await symlink(outside, path.join(root, 'objects', 'link.txt'));

    const viaRead = await bytesAt(store, 'link.txt');
    await store.copy('link.txt', 'dest.txt');

    expect(viaRead).not.toBeNull();
    expect(Buffer.from((await bytesAt(store, 'dest.txt'))!)).toEqual(Buffer.from(viaRead!));
  });
});
