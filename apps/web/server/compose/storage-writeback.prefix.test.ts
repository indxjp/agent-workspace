/**
 * Write-back (US-STO-12): nothing is written outside the granted prefix, whatever the archive or the launch body says.
 */
// @story US-STO-12
import { encodeUstar, type TarEntry } from '@agent-workspace/runtime/transfer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONNECTION,
  CWD,
  FOLDER,
  NOTHING,
  entriesOf,
  forged,
  reportsGrant,
  tarOf,
  writeBack,
} from './storage-writeback.test-support';

afterEach(() => vi.restoreAllMocks());

describe('nothing is written outside the granted prefix', () => {
  it('[US-STO-12][unit][run] refuses, counts and skips members that are not plain descendants', async () => {
    const result = await writeBack({
      tar: () =>
        encodeUstar([
          ...entriesOf({ 'ok.md': 'ok' }, FOLDER),
          ...entriesOf({ 'x.md': 'sibling' }, `${CWD}/storage/acme-data/reports-evil`),
          ...entriesOf({ 'x.md': 'outputs' }, `${CWD}/outputs`),
          ...entriesOf({ 'a\\b.md': 'backslash' }, FOLDER),
        ]),
    });

    expect([...result.objects.keys()]).toEqual(['reports/ok.md']);
    expect(result.counts).toMatchObject({ written: 1, refused: 3 });
  });

  it('[US-STO-12][unit][run] refuses a member whose key the object-store guard refuses', async () => {
    // A plain path segment that only the key guard refuses: `%` could decode to a separator.
    const result = await writeBack({ files: { 'ok.md': 'ok', 'a%2e.md': 'escaped' } });

    expect([...result.objects.keys()]).toEqual(['reports/ok.md']);
    expect(result.counts).toMatchObject({ written: 1, refused: 1 });
  });

  const entries: readonly TarEntry[] = entriesOf({ 'ok.md': 'ok', 'evil.md': 'evil' }, FOLDER);
  const hostile: readonly [string, Uint8Array][] = [
    ['a symlink', forged(entries, { type: 0x32 })],
    ['a hard link', forged(entries, { type: 0x31 })],
    ['a parent segment', forged(entries, { name: `${FOLDER}/../../../etc/cron.d/x` })],
    ['an absolute path', forged(entries, { name: '/etc/cron.d/x' })],
  ];

  it.each(hostile)(
    '[US-STO-12][unit][run] refuses the whole grant for an archive with %s',
    async (_name, tar) => {
      const result = await writeBack({ tar: (path) => (path === FOLDER ? tar : null) });

      expect(result.attempts).toEqual([]);
      expect(result.objects.size).toBe(0);
      expect(result.counts).toEqual({ ...NOTHING, refused: 1 });
      expect(result.labels()[0]).toContain('refused: archive_refused');
    },
  );
});

describe('overlapping grants and the launch body', () => {
  it('[US-STO-12][unit][run] leaves a read-only overlapping folder alone', async () => {
    const result = await writeBack({
      grants: [reportsGrant(CONNECTION), reportsGrant(CONNECTION, 'reports/2026', 'read')],
      files: { '2026/q3.csv': 'tampered', 'top.md': 'top' },
    });

    expect([...result.objects.keys()]).toEqual(['reports/top.md']);
    expect(result.counts).toMatchObject({ written: 1, refused: 1 });
  });

  it('[US-STO-12][unit][run] writes and counts a file once when two read-write grants overlap', async () => {
    const result = await writeBack({
      grants: [reportsGrant(CONNECTION), reportsGrant(CONNECTION, 'reports/2026')],
      tar: (path) =>
        path === FOLDER
          ? tarOf({ '2026/q3.csv': 'q3,43\n', 'top.md': 'top' })
          : path === `${FOLDER}/2026`
            ? tarOf({ 'q3.csv': 'q3,43\n' }, path)
            : null,
    });

    expect(result.reads).toEqual([FOLDER, FOLDER, `${FOLDER}/2026`]);
    expect(result.attempts.sort()).toEqual(['reports/2026/q3.csv', 'reports/top.md']);
    expect(result.counts).toEqual({ ...NOTHING, written: 2, bytes: 9 });
  });
});

describe('write-back needs the launch body and the grants as they are now to allow a file', () => {
  const broad = reportsGrant(CONNECTION);
  const nested = reportsGrant(CONNECTION, 'reports/2026', 'read');
  const files = { '2026/q3.csv': 'q3,43\n', 'top.md': '# Top\n' };

  it('[US-STO-12][unit][run] keeps a folder read-only whose read grant was removed during the run', async () => {
    const result = await writeBack({ launchGrants: [broad, nested], grants: [broad], files });

    expect(result.attempts).toEqual(['reports/top.md']);
    expect(result.objects.has('reports/2026/q3.csv')).toBe(false);
    expect(result.counts).toEqual({ ...NOTHING, written: 1, refused: 1, bytes: 6 });
  });

  it('[US-STO-12][unit][run] keeps an exact file read-only that the launch body delivered read-only', async () => {
    const result = await writeBack({
      launchReadOnlyFiles: ['2026/q3.csv'],
      files: { ...files, '2026/q2.csv': 'q2,41\n' },
    });

    expect(result.attempts.sort()).toEqual(['reports/2026/q2.csv', 'reports/top.md']);
    expect(result.objects.has('reports/2026/q3.csv')).toBe(false);
    expect(result.counts).toEqual({ ...NOTHING, written: 2, refused: 1, bytes: 12 });
  });

  it('[US-STO-12][unit][run] writes a sibling folder that only shares the read-only folder name as a prefix', async () => {
    const result = await writeBack({
      launchGrants: [broad, nested],
      grants: [broad],
      files: { ...files, '20261/x.csv': 'x\n' },
    });

    expect(result.attempts.sort()).toEqual(['reports/20261/x.csv', 'reports/top.md']);
    expect(result.counts).toEqual({ ...NOTHING, written: 2, refused: 1, bytes: 8 });
  });

  it('[US-STO-12][unit][run] keeps everything under a read-only launch entry that names no kind', async () => {
    const result = await writeBack({
      launchEntries: [{ path: 'storage/acme-data/reports/2026', access: 'read' }],
      files,
    });

    expect(result.attempts).toEqual(['reports/top.md']);
    expect(result.counts).toEqual({ ...NOTHING, written: 1, refused: 1, bytes: 6 });
  });

  it('[US-STO-12][unit][run] writes nothing when the read-write grant was removed during the run', async () => {
    const result = await writeBack({ launchGrants: [broad, nested], grants: [nested], files });

    expect(result.attempts).toEqual([]);
    expect(result.labels()).toEqual([expect.stringContaining('refused: grant_missing')]);
  });

  it('[US-STO-12][unit][run] honours a read grant added during the run', async () => {
    const result = await writeBack({ launchGrants: [broad], grants: [broad, nested], files });

    expect(result.attempts).toEqual(['reports/top.md']);
    expect(result.counts).toEqual({ ...NOTHING, written: 1, refused: 1, bytes: 6 });
  });
});
