import { log as webLogger } from '../telemetry/logger';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadRuntimeVerificationCache } from './verification-store';

const readOnly = vi.hoisted(() => ({ on: false, code: 'EROFS' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: (...args: Parameters<typeof actual.mkdir>) =>
      readOnly.on
        ? Promise.reject(Object.assign(new Error('read-only file system'), { code: readOnly.code }))
        : actual.mkdir(...args),
  };
});

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

describe('runtime verification persistence', () => {
  it('survives a process cache reload and binds success to configuration and expiry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-verification-'));
    roots.push(root);
    const file = path.join(root, 'verification.json');
    const first = await loadRuntimeVerificationCache(file);
    await first.record('docker', 'image-a', {
      fingerprint: 'fingerprint-a',
      verifiedAt: '2026-09-10T00:00:00.000Z',
      expiresAt: '2026-09-11T00:00:00.000Z',
    });

    const reloaded = await loadRuntimeVerificationCache(file);
    expect(reloaded.wasVerified('docker', 'image-a', new Date('2026-09-10T12:00:00Z'))).toBe(true);
    expect(reloaded.wasVerified('docker', 'image-b', new Date('2026-09-10T12:00:00Z'))).toBe(false);
    expect(reloaded.wasVerified('docker', 'image-a', new Date('2026-09-12T00:00:00Z'))).toBe(false);
    // BH061-002: a lapsed pass still says the driver passed here once, so a run may renew it.
    expect(reloaded.hasPassed('docker')).toBe(true);
    expect(reloaded.hasPassed('kubernetes')).toBe(false);
  });

  it('fails closed when persisted state is malformed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-verification-'));
    roots.push(root);
    const file = path.join(root, 'verification.json');
    await writeFile(file, '{not-json');
    await expect(loadRuntimeVerificationCache(file)).rejects.toThrow('state is unreadable');
  });

  it('keeps a verification in memory when its directory is on a read-only filesystem', async () => {
    readOnly.on = true;
    const warn = vi.spyOn(webLogger, 'warn').mockImplementation(() => undefined);
    try {
      const cache = await loadRuntimeVerificationCache('/read-only/verification.json');
      const verification = {
        fingerprint: 'fingerprint-a',
        verifiedAt: '2026-09-10T00:00:00.000Z',
        expiresAt: '2026-09-11T00:00:00.000Z',
      };
      await cache.record('kubernetes', 'image-a', verification);
      await cache.record('kubernetes', 'image-a', verification);
      expect(cache.wasVerified('kubernetes', 'image-a', new Date('2026-09-10T12:00:00Z'))).toBe(
        true,
      );
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      readOnly.on = false;
      warn.mockRestore();
    }
  });

  it('fails the record with the errno when the directory cannot be created for another reason', async () => {
    readOnly.on = true;
    readOnly.code = 'EACCES';
    try {
      const cache = await loadRuntimeVerificationCache(
        '/var/lib/agent-workspace/verification.json',
      );
      const error: unknown = await cache
        .record('external', 'image-a', {
          fingerprint: 'fingerprint-a',
          verifiedAt: '2026-09-10T00:00:00.000Z',
          expiresAt: '2026-09-11T00:00:00.000Z',
        })
        .catch((cause: unknown) => cause);
      // Setup shows the name and this errno for it: a bare `Error` with no cause named.
      expect(error).toMatchObject({ name: 'Error', code: 'EACCES' });
    } finally {
      readOnly.on = false;
      readOnly.code = 'EROFS';
    }
  });
});
