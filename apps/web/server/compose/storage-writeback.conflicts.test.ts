/**
 * Write-back (US-STO-12): a file that moved on in the bucket is kept, and one file failing leaves the others alone.
 */
// @story US-STO-12
import { ObjectConflictError } from '@agent-workspace/core/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { log } from '../telemetry/logger';
import { FOLDER, NOTHING, tarOf, writeBack } from './storage-writeback.test-support';

afterEach(() => vi.restoreAllMocks());

describe('a file that moved on in the bucket is kept', () => {
  it('[US-STO-12][unit][run] keeps the bucket version of a file changed there during the run', async () => {
    const result = await writeBack({
      delivered: { 'q3.csv': 'q3,42\n' },
      bucket: { 'reports/q3.csv': 'edited elsewhere\n' },
      files: { 'q3.csv': 'q3,43\n', 'new.md': 'new' },
    });

    expect(result.objects.get('reports/q3.csv')).toBe('edited elsewhere\n');
    expect(result.objects.get('reports/new.md')).toBe('new');
    expect(result.counts).toMatchObject({ written: 1, conflicted: 1 });
  });

  it('[US-STO-12][unit][run] keeps the bucket version of a file deleted there during the run', async () => {
    const result = await writeBack({
      delivered: { 'q3.csv': 'q3,42\n' },
      files: { 'q3.csv': 'q3,43\n' },
    });

    expect(result.objects.size).toBe(0);
    expect(result.counts).toMatchObject({ written: 0, conflicted: 1 });
  });

  it('[US-STO-12][unit][run] counts a delivered file whose bucket is gone as failed, not conflicted', async () => {
    // The store raises for a missing bucket; only a missing object answers `null`.
    const result = await writeBack({
      delivered: { 'q3.csv': 'q3,42\n' },
      bucket: { 'reports/q3.csv': 'q3,42\n' },
      files: { 'q3.csv': 'q3,43\n' },
      seams: { failRead: () => new Error('NoSuchBucket') },
    });

    expect(result.counts).toMatchObject({ written: 0, conflicted: 0, failed: 1 });
  });
});

describe('a file the store or another writer changes after the check is kept', () => {
  it('[US-STO-12][unit][run] keeps the bucket version of a file created there during the run', async () => {
    const result = await writeBack({
      bucket: { 'reports/new.md': 'theirs' },
      files: { 'new.md': 'ours' },
    });

    expect(result.objects.get('reports/new.md')).toBe('theirs');
    expect(result.counts).toMatchObject({ written: 0, conflicted: 1 });
  });

  it('[US-STO-12][unit][run] counts a precondition the store refuses after the check as a conflict', async () => {
    const result = await writeBack({
      delivered: { 'q3.csv': 'q3,42\n' },
      bucket: { 'reports/q3.csv': 'q3,42\n' },
      files: { 'q3.csv': 'q3,43\n', 'new.md': 'new' },
      seams: {
        failWrite: (key) => (key === 'reports/q3.csv' ? new ObjectConflictError() : undefined),
      },
    });

    expect(result.objects.get('reports/q3.csv')).toBe('q3,42\n');
    expect(result.counts).toMatchObject({ written: 1, conflicted: 1, failed: 0 });
  });

  it('[US-STO-12][unit][run] keeps a change made between the hash check and the write (ifMatch)', async () => {
    const result = await writeBack({
      delivered: { 'q3.csv': 'q3,42\n' },
      bucket: { 'reports/q3.csv': 'q3,42\n' },
      files: { 'q3.csv': 'q3,43\n' },
      seams: {
        beforeWrite: (key, objects) => {
          if (key === 'reports/q3.csv') objects.set(key, 'edited in between\n');
        },
      },
    });

    expect(result.objects.get('reports/q3.csv')).toBe('edited in between\n');
    expect(result.counts).toMatchObject({ written: 0, conflicted: 1 });
  });
});

describe('a store write racing another writer mid-upload', () => {
  it('[US-STO-12][unit][run] keeps a delivered file another writer changed while it was uploading', async () => {
    const result = await writeBack({
      delivered: { 'q3.csv': 'q3,42\n', 'q2.csv': 'q2,40\n' },
      bucket: { 'reports/q3.csv': 'q3,42\n', 'reports/q2.csv': 'q2,40\n' },
      files: { 'q3.csv': 'q3,43\n', 'q2.csv': 'q2,41\n' },
      seams: {
        duringWrite: (key, objects) => {
          if (key === 'reports/q3.csv') objects.set(key, 'theirs, mid-upload\n');
        },
      },
    });

    expect(result.attempts.sort()).toEqual(['reports/q2.csv', 'reports/q3.csv']);
    expect(result.objects.get('reports/q3.csv')).toBe('theirs, mid-upload\n');
    expect(result.objects.get('reports/q2.csv')).toBe('q2,41\n');
    expect(result.counts).toEqual({ ...NOTHING, written: 1, conflicted: 1, bytes: 6 });
    expect(result.labels()).toEqual([
      'run run-1 · 1 written · 0 unchanged · 1 conflicted · 0 refused · 0 failed · 6 bytes',
    ]);
  });

  it('[US-STO-12][unit][run] keeps a file another writer created while a new one was uploading', async () => {
    const result = await writeBack({
      files: { 'new.md': 'ours' },
      seams: {
        duringWrite: (key, objects) => {
          objects.set(key, 'theirs');
        },
      },
    });

    expect(result.attempts).toEqual(['reports/new.md']);
    expect(result.objects.get('reports/new.md')).toBe('theirs');
    expect(result.counts).toEqual({ ...NOTHING, conflicted: 1 });
  });

  it('[US-STO-12][unit][run] keeps a file another writer deleted while it was uploading', async () => {
    const result = await writeBack({
      delivered: { 'q3.csv': 'q3,42\n' },
      bucket: { 'reports/q3.csv': 'q3,42\n' },
      files: { 'q3.csv': 'q3,43\n' },
      seams: {
        duringWrite: (key, objects) => {
          objects.delete(key);
        },
      },
    });

    // Write-back never deletes, and a delete it raced is not undone by a recreate either.
    expect(result.objects.has('reports/q3.csv')).toBe(false);
    expect(result.counts).toEqual({ ...NOTHING, conflicted: 1 });
  });
});

describe('one file failing does not stop the others', () => {
  it('[US-STO-12][unit][run] saves the rest and does not throw', async () => {
    const result = await writeBack({
      files: { 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' },
      seams: { failWrite: (key) => (key === 'reports/b.md' ? new Error('disk full') : undefined) },
    });

    expect([...result.objects.keys()].sort()).toEqual(['reports/a.md', 'reports/c.md']);
    expect(result.counts).toMatchObject({ written: 2, failed: 1 });
    expect(result.audit).toHaveBeenCalledOnce();
  });

  it('[US-STO-12][unit][run] writes no part of a file that changed between the two reads', async () => {
    const result = await writeBack({
      tar: (path, read) =>
        path === FOLDER ? tarOf({ 'a.md': read === 1 ? 'first' : 'second', 'b.md': 'b' }) : null,
    });

    expect(result.objects.has('reports/a.md')).toBe(false);
    expect(result.objects.get('reports/b.md')).toBe('b');
    expect(result.counts).toMatchObject({ written: 1, failed: 1 });
  });

  it('[US-STO-12][unit][run] counts a file the second read never reached as failed', async () => {
    const result = await writeBack({
      tar: (path, read) =>
        path === FOLDER ? tarOf(read === 1 ? { 'a.md': 'a', 'b.md': 'b' } : { 'a.md': 'a' }) : null,
    });

    expect([...result.objects.keys()]).toEqual(['reports/a.md']);
    expect(result.counts).toMatchObject({ written: 1, failed: 1 });
  });

  it('[US-STO-12][unit][run] survives an audit that cannot be recorded', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const result = await writeBack({
      files: { 'a.md': 'a' },
      audit: () => Promise.reject(new Error('audit store down')),
    });

    expect(result.objects.get('reports/a.md')).toBe('a');
    expect(error).toHaveBeenCalledOnce();
  });
});
