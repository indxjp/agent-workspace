/**
 * Write-back (US-STO-12): what a read-write grant saves, and the gates read again at the end of the run.
 */
// @story US-STO-12
import { encodeUstar } from '@agent-workspace/runtime/transfer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONNECTION,
  CWD,
  FOLDER,
  NOTHING,
  OTHER,
  TWO_CONNECTION_FOLDERS,
  TWO_CONNECTION_GRANTS,
  connectionRow,
  entriesOf,
  reportsGrant,
  tarOf,
  writeBack,
  type Setup,
} from './storage-writeback.test-support';

afterEach(() => vi.restoreAllMocks());

describe('a read-write grant is written back', () => {
  it('[US-STO-12][unit][run] saves only the files that are new or changed', async () => {
    const before = { '2026/q3.csv': 'q3,42\n', '2026/q2.csv': 'q2,40\n' };
    const result = await writeBack({
      delivered: before,
      bucket: Object.fromEntries(Object.entries(before).map(([n, c]) => [`reports/${n}`, c])),
      files: { '2026/q3.csv': 'q3,42\n', '2026/q2.csv': 'q2,41\n', 'summary.md': '# Q3\n' },
    });

    expect(result.attempts.sort()).toEqual(['reports/2026/q2.csv', 'reports/summary.md']);
    expect(result.objects.get('reports/2026/q2.csv')).toBe('q2,41\n');
    expect(result.objects.get('reports/summary.md')).toBe('# Q3\n');
    expect(result.counts).toEqual({ ...NOTHING, written: 2, unchanged: 1, bytes: 11 });
  });

  it('[US-STO-12][unit][run] deletes nothing a run removed', async () => {
    const before = { '2026/q3.csv': 'q3,42\n', '2026/q2.csv': 'q2,40\n' };
    const result = await writeBack({
      delivered: before,
      bucket: Object.fromEntries(Object.entries(before).map(([n, c]) => [`reports/${n}`, c])),
      files: { '2026/q3.csv': 'q3,43\n' },
    });

    expect(result.objects.get('reports/2026/q2.csv')).toBe('q2,40\n');
    expect(result.objects.get('reports/2026/q3.csv')).toBe('q3,43\n');
  });

  it('[US-STO-12][unit][run] writes a file created in a folder the grant covers, never above it', async () => {
    const result = await writeBack({ files: { 'new/deep/note.md': 'hi' } });
    expect([...result.objects.keys()]).toEqual(['reports/new/deep/note.md']);
  });

  it('[US-STO-12][unit][run] neither writes nor counts the directory entries of the archive', async () => {
    const result = await writeBack({
      tar: (path) =>
        path === FOLDER
          ? encodeUstar([
              { path: `${FOLDER}/2026`, type: 'directory', mode: 0o755 },
              { path: `${FOLDER}/2026/empty`, type: 'directory', mode: 0o755 },
              ...entriesOf({ '2026/q3.csv': 'q3,42\n' }, FOLDER),
            ])
          : null,
    });

    expect(result.attempts).toEqual(['reports/2026/q3.csv']);
    expect(result.counts).toEqual({ ...NOTHING, written: 1, bytes: 6 });
  });

  it('[US-STO-12][unit][run] writes nothing for a folder the run was not delivered writable', async () => {
    const result = await writeBack({ deliveredFolders: {}, files: { 'summary.md': '# Q3\n' } });

    expect(result.reads).toEqual([]);
    expect(result.objects.size).toBe(0);
    expect(result.audit).not.toHaveBeenCalled();
  });
});

describe('the folder is the one that was delivered, whatever the connection is called now', () => {
  it('[US-STO-12][unit][run] still writes to a connection renamed during the run', async () => {
    const result = await writeBack({
      connections: {
        [CONNECTION]: { name: 'renamed', allowedPrefixes: ['reports'], writeAllowed: true },
      },
      files: { 'summary.md': '# Q3\n' },
    });

    expect(result.reads).toContain(FOLDER);
    expect(result.objects.get('reports/summary.md')).toBe('# Q3\n');
  });

  it('[US-STO-12][unit][run] never crosses two connections whose names were swapped', async () => {
    const result = await writeBack({
      grants: TWO_CONNECTION_GRANTS,
      deliveredFolders: TWO_CONNECTION_FOLDERS,
      // Swapped since delivery: each id now carries the other's name.
      connections: { [CONNECTION]: connectionRow('beta'), [OTHER]: connectionRow('acme-data') },
      tar: (path) =>
        path === FOLDER
          ? tarOf({ 'a.md': 'for acme' })
          : path === `${CWD}/storage/beta/reports`
            ? tarOf({ 'b.md': 'for beta' }, path)
            : null,
    });

    expect([...result.objects.entries()]).toEqual([['reports/a.md', 'for acme']]);
    expect([...(result.buckets.get(OTHER)?.objects.entries() ?? [])]).toEqual([
      ['reports/b.md', 'for beta'],
    ]);
  });
});

describe('the folder is written only when the archive and compose loads agree on its grant', () => {
  it('[US-STO-12][unit][run] writes a folder both loads delivered for the same grant', async () => {
    const result = await writeBack({
      hydratedFolders: {
        'storage/acme-data/reports': { connectionId: CONNECTION, prefix: 'reports' },
      },
      files: { 'summary.md': '# Q3\n' },
    });

    expect(result.objects.get('reports/summary.md')).toBe('# Q3\n');
  });

  it('[US-STO-12][unit][run] refuses a folder whose name moved to another connection between the two loads', async () => {
    // The archive put OTHER's files at `storage/acme-data/reports`; by the compose load the name
    // `acme-data` was CONNECTION's, so what the agent left there is OTHER's, not CONNECTION's.
    const result = await writeBack({
      grants: TWO_CONNECTION_GRANTS,
      hydratedFolders: { 'storage/acme-data/reports': { connectionId: OTHER, prefix: 'reports' } },
      deliveredFolders: {
        'storage/acme-data/reports': { connectionId: CONNECTION, prefix: 'reports' },
      },
      connections: { [CONNECTION]: connectionRow('acme-data'), [OTHER]: connectionRow('acme-old') },
      delivered: { 'q3.csv': 'q3,42\n' },
      bucket: { 'reports/q3.csv': 'q3,42\n' },
      files: { 'q3.csv': 'q3,43\n', 'new.md': 'from the other connection' },
    });

    expect(result.reads).toEqual([]);
    expect(result.opened).toEqual([]);
    expect(result.objects.get('reports/q3.csv')).toBe('q3,42\n');
    expect(result.objects.has('reports/new.md')).toBe(false);
    expect(result.buckets.get(OTHER)).toBeUndefined();
    expect(result.labels()).toEqual([
      'run run-1 · 0 written · 0 unchanged · 0 conflicted · 1 refused · 0 failed · 0 bytes · refused: folder_mismatch',
    ]);
  });

  it('[US-STO-12][unit][run] refuses a folder the archive load did not deliver', async () => {
    const result = await writeBack({ hydratedFolders: {}, files: { 'new.md': 'new' } });

    expect(result.objects.size).toBe(0);
    expect(result.labels()[0]).toContain('refused: folder_mismatch');
  });

  it('[US-STO-12][unit][run] refuses a folder the archive load delivered for another prefix', async () => {
    const result = await writeBack({
      hydratedFolders: {
        'storage/acme-data/reports': { connectionId: CONNECTION, prefix: 'data' },
      },
      files: { 'new.md': 'new' },
    });

    expect(result.objects.size).toBe(0);
    expect(result.labels()[0]).toContain('refused: folder_mismatch');
  });
});

describe('every gate is read again when the run has finished', () => {
  const closed: readonly [string, Setup, string][] = [
    ['the connection stopped allowing writes', { writeAllowed: false }, 'write_not_allowed'],
    [
      'the grant is read only now',
      {
        grants: [reportsGrant(CONNECTION, 'reports', 'read')],
        deliveredFolders: {
          'storage/acme-data/reports': { connectionId: CONNECTION, prefix: 'reports' },
        },
      },
      'grant_missing',
    ],
    ['the agent may not write files', { agentWritesFiles: false }, 'agent_cannot_write'],
    ['the run was not allowed to write files', { bodyWritesFiles: false }, 'run_cannot_write'],
    ['the connection is gone', { connections: {} }, 'connection_missing'],
    ['the grant row or version is gone', { runAgentGone: true }, 'grant_missing'],
    [
      'the connection no longer allows the folder',
      { allowedPrefixes: ['raw'] },
      'prefix_not_allowed',
    ],
  ];

  it.each(closed)(
    '[US-STO-12][unit][run] writes nothing, and records why, when %s',
    async (_name, setup, reason) => {
      const result = await writeBack({ ...setup, files: { 'summary.md': '# Q3\n' } });

      expect(result.attempts).toEqual([]);
      expect(result.opened).toEqual([]);
      expect(result.objects.size).toBe(0);
      expect(result.labels()).toEqual([
        `run run-1 · 0 written · 0 unchanged · 0 conflicted · 1 refused · 0 failed · 0 bytes · refused: ${reason}`,
      ]);
    },
  );

  it('[US-STO-12][unit][run] refuses a grant whose folder the connection allows only in part', async () => {
    // The connection allows `reports/2026` only: the grant gate, not the per-key check, refuses it.
    const result = await writeBack({
      allowedPrefixes: ['reports/2026'],
      files: { '2026/q3.csv': 'q3,43\n', 'top.md': 'top' },
    });

    expect(result.attempts).toEqual([]);
    expect(result.labels()[0]).toContain('refused: prefix_not_allowed');
  });
});
