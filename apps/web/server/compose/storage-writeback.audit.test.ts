/**
 * Write-back (US-STO-12): the audit row holds counts and a reason code only, and what the write-back logs.
 */
// @story US-STO-12
import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureLog } from '../telemetry/capture-log';
import { log } from '../telemetry/logger';
import { STORAGE_WRITEBACK_AUDIT_DEADLINE_MS, writeBackLabel } from './storage-writeback';
import {
  CONNECTION,
  CWD,
  FOLDER,
  NOTHING,
  OTHER,
  TWO_CONNECTION_FOLDERS,
  TWO_CONNECTION_GRANTS,
  WORKSPACE,
  reportsGrant,
  tarOf,
  writeBack,
} from './storage-writeback.test-support';

afterEach(() => vi.restoreAllMocks());

describe('the audit row', () => {
  it('[US-STO-12][unit][run] is one row per connection whose label is counts only', async () => {
    // Built at run time: a literal key-shaped string would trip the secret scanner.
    const secret = randomBytes(16).toString('hex');
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const result = await writeBack({
      grants: [reportsGrant(CONNECTION), reportsGrant(CONNECTION, 'data')],
      connections: {
        [CONNECTION]: {
          name: `acme-${secret}`,
          allowedPrefixes: ['reports', 'data'],
          writeAllowed: true,
        },
      },
      tar: (path) =>
        path === FOLDER
          ? tarOf({ [`${secret}.md`]: `content ${secret}` })
          : path === `${CWD}/storage/acme-data/data`
            ? tarOf({ 'two.md': 'two' }, path)
            : null,
    });

    expect(result.audit).toHaveBeenCalledOnce();
    expect(result.audit.mock.calls[0]?.[0]).toEqual({
      workspaceId: WORKSPACE,
      actorPrincipalId: 'principal-1',
      actorUserId: 'user-1',
      actorLabel: 'run run-1',
      action: 'storage-connection-written',
      subjectId: CONNECTION,
      subjectLabel: `run run-1 · 2 written · 0 unchanged · 0 conflicted · 0 refused · 0 failed · ${String(`content ${secret}`.length + 3)} bytes`,
    });
    const logged = JSON.stringify([result.audit.mock.calls, info.mock.calls]);
    for (const leaked of [secret, 'two.md', CWD, '/storage/', 'reports/', 'acme-'])
      expect(logged).not.toContain(leaked);
    expect(info.mock.calls[0]?.[1]).toMatchObject({ connectionId: CONNECTION, written: 2 });
  });

  it('[US-STO-12][unit][run] names no key or error message when files conflict and fail', async () => {
    const result = await writeBack({
      bucket: { 'reports/taken.md': 'theirs' },
      files: { 'taken.md': 'ours', 'broken.md': 'x', 'ok.md': 'ok' },
      seams: {
        failWrite: (key) =>
          key === 'reports/broken.md' ? new Error('secret-bucket-path exploded') : undefined,
      },
    });

    expect(result.labels()).toEqual([
      'run run-1 · 1 written · 0 unchanged · 1 conflicted · 0 refused · 1 failed · 2 bytes',
    ]);
  });
});

describe('the audit label', () => {
  it('[US-STO-12][unit][run] writes the label from counts and the reason code alone', () => {
    const counts = { written: 1, unchanged: 2, conflicted: 3, refused: 4, failed: 5, bytes: 6 };
    expect(writeBackLabel('r', counts, null)).toBe(
      'run r · 1 written · 2 unchanged · 3 conflicted · 4 refused · 5 failed · 6 bytes',
    );
    expect(writeBackLabel('r', counts, 'deadline')).toBe(
      'run r · 1 written · 2 unchanged · 3 conflicted · 4 refused · 5 failed · 6 bytes · refused: deadline',
    );
  });
});

describe('the audit row is written only when it says something', () => {
  it('[US-STO-12][unit][run] is left out when the run changed nothing', async () => {
    const result = await writeBack({
      delivered: { 'q3.csv': 'q3,42\n' },
      bucket: { 'reports/q3.csv': 'q3,42\n' },
      files: { 'q3.csv': 'q3,42\n' },
    });

    expect(result.counts).toEqual({ ...NOTHING, unchanged: 1 });
    expect(result.audit).not.toHaveBeenCalled();
  });

  it('[US-STO-12][unit][run] records a refusal even when nothing was written', async () => {
    const result = await writeBack({ writeAllowed: false, files: { 'a.md': 'a' } });

    expect(result.counts).toEqual({ ...NOTHING, refused: 1 });
    expect(result.audit).toHaveBeenCalledOnce();
  });

  it("[US-STO-12][unit][run] still records the first grant's row when the second grant throws", async () => {
    const result = await writeBack({
      grants: TWO_CONNECTION_GRANTS,
      deliveredFolders: TWO_CONNECTION_FOLDERS,
      connections: {
        [CONNECTION]: { name: 'acme-data', allowedPrefixes: ['reports'], writeAllowed: true },
        [OTHER]: new Error('the connection store is down'),
      },
      files: { 'a.md': 'a' },
    });

    expect(result.audit.mock.calls.map(([event]) => [event.subjectId, event.subjectLabel])).toEqual(
      [
        [
          CONNECTION,
          'run run-1 · 1 written · 0 unchanged · 0 conflicted · 0 refused · 0 failed · 1 bytes',
        ],
        [
          OTHER,
          'run run-1 · 0 written · 0 unchanged · 0 conflicted · 1 refused · 0 failed · 0 bytes · refused: connection_unavailable',
        ],
      ],
    );
  });
});

describe('what the write-back logs', () => {
  it('[US-STO-12][unit][run] names no key a store error carries', async () => {
    // A customer's file name, not a credential: the redactor masks secrets, not names.
    const secret = 'board-minutes-acquisition-plan';
    const logged = captureLog();
    const result = await writeBack({
      files: { [`${secret}.md`]: 'x' },
      seams: {
        failWrite: (key) => new Error(`PutObject on ${key} failed: AccessDenied`),
      },
    });
    logged.restore();

    expect(result.counts).toMatchObject({ failed: 1 });
    expect(logged.text()).toContain('storage write-back could not write a file');
    expect(logged.text()).not.toContain(secret);
  });
});

describe('the audit write', () => {
  it('[US-STO-12][unit][run] cannot keep the session busy when it never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
      const pending = writeBack({
        files: { 'a.md': 'a' },
        audit: () => new Promise<never>(() => undefined),
      });
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(STORAGE_WRITEBACK_AUDIT_DEADLINE_MS);
      const result = await pending;

      expect(settled).toBe(true);
      expect(result.objects.get('reports/a.md')).toBe('a');
      expect(error).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
