import { describe, expect, it } from 'vitest';

import {
  breadcrumbSegments,
  canonicalizeFolderPath,
  formatModified,
  formatSize,
  sortedRows,
  toFileRows,
  type FileRow,
} from './resource-screens';

describe('canonicalizeFolderPath', () => {
  it('passes through an ordinary nested path unchanged', () => {
    expect(canonicalizeFolderPath('a/b/c')).toBe('a/b/c');
  });

  it('treats null, undefined and the empty string as the root', () => {
    expect(canonicalizeFolderPath(null)).toBe('');
    expect(canonicalizeFolderPath(undefined)).toBe('');
    expect(canonicalizeFolderPath('')).toBe('');
  });

  it('drops "." segments', () => {
    expect(canonicalizeFolderPath('a/./b')).toBe('a/b');
  });

  // Verifier attack 1: hand-editing the URL to a traversal, an absolute path, or a
  // percent-encoded dot-segment must never leave as a request containing a traversal — it is
  // clamped inside the workspace instead of being forwarded as-is.
  it('clamps a "../../../" climb at the root rather than escaping it', () => {
    expect(canonicalizeFolderPath('a/b/../../../etc')).toBe('etc');
  });

  it('clamps a lone ".." at the root to the empty (root) path', () => {
    expect(canonicalizeFolderPath('..')).toBe('');
    expect(canonicalizeFolderPath('../../..')).toBe('');
  });

  it('treats a leading "/" as relative to the workspace root, not as an absolute path', () => {
    expect(canonicalizeFolderPath('/absolute/path')).toBe('absolute/path');
  });

  it('resolves a percent-encoded dot-segment the same way as a literal one', () => {
    expect(canonicalizeFolderPath('a/b/%2e%2e/')).toBe('a');
  });

  it('keeps a malformed percent-encoding as a literal, harmless segment rather than throwing', () => {
    expect(canonicalizeFolderPath('a/50%/b')).toBe('a/50%/b');
  });

  it('never returns a path containing a "." or ".." segment, for a battery of hostile inputs', () => {
    const hostile = [
      'a/b/../../../etc',
      '../../../../etc/passwd',
      '/etc/passwd',
      'a/../../b',
      '%2e%2e/%2e%2e/root',
      'a/./././b',
    ];
    for (const raw of hostile) {
      const result = canonicalizeFolderPath(raw);
      expect(result.split('/')).not.toContain('..');
      expect(result.split('/')).not.toContain('.');
      expect(result.startsWith('/')).toBe(false);
    }
  });
});

describe('breadcrumbSegments', () => {
  it('is empty at the root', () => {
    expect(breadcrumbSegments('')).toEqual([]);
  });

  it('accumulates the path up to each segment', () => {
    expect(breadcrumbSegments('a/b/c')).toEqual([
      { name: 'a', path: 'a' },
      { name: 'b', path: 'a/b' },
      { name: 'c', path: 'a/b/c' },
    ]);
  });
});

describe('formatSize', () => {
  it('renders an em dash for an unknown size', () => {
    expect(formatSize(null)).toBe('—');
  });

  it('renders sub-kilobyte sizes in bytes', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
  });

  it('renders one decimal place under 10 units, none at or above it', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(10240)).toBe('10 KB');
  });

  it('climbs units for a megabyte-sized file', () => {
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
  });
});

describe('formatModified', () => {
  it('renders an em dash for a folder (no lastModified)', () => {
    expect(formatModified(null)).toBe('—');
  });

  it("shows the time in the reader's own zone, with the zone named (UX-15)", () => {
    const iso = '2026-09-11T10:15:30.000Z';
    expect(formatModified(iso, 'ja', 'Asia/Tokyo')).toBe('2026年9月11日 19:15 JST');
    expect(formatModified(iso, 'en', 'America/New_York')).toBe('Sep 11, 2026, 06:15 AM EDT');
    expect(formatModified(iso, 'en', 'UTC')).toBe('Sep 11, 2026, 10:15 AM UTC');
  });

  it('speaks English when no language is given', () => {
    expect(formatModified('2026-09-11T10:15:30.000Z', undefined, 'UTC')).toBe(
      'Sep 11, 2026, 10:15 AM UTC',
    );
  });

  it('falls back to the raw string when it is not the expected ISO shape', () => {
    expect(formatModified('not-a-date')).toBe('not-a-date');
  });
});

describe('toFileRows and sortedRows', () => {
  it('narrows the loosely-typed API body and defaults a missing kind to "file"', () => {
    const rows = toFileRows({
      files: [
        { id: '1', path: 'a.txt', sizeBytes: 3, contentType: 'text/plain', lastModified: 'x' },
        { id: '2', path: 'sub', kind: 'folder' },
        'not-an-object',
      ],
    });
    expect(rows).toEqual([
      {
        id: '1',
        path: 'a.txt',
        kind: 'file',
        sizeBytes: 3,
        contentType: 'text/plain',
        lastModified: 'x',
      },
      {
        id: '2',
        path: 'sub',
        kind: 'folder',
        sizeBytes: null,
        contentType: null,
        lastModified: null,
      },
    ]);
  });

  it('returns no rows when "files" is missing or not an array', () => {
    expect(toFileRows({})).toEqual([]);
    expect(toFileRows({ files: 'nope' })).toEqual([]);
  });
});

describe('sortedRows', () => {
  it('sorts folders before files, each group alphabetically by name', () => {
    const unsorted: FileRow[] = [
      {
        id: '1',
        path: 'zeta.txt',
        kind: 'file',
        sizeBytes: 0,
        contentType: null,
        lastModified: null,
      },
      {
        id: '2',
        path: 'beta',
        kind: 'folder',
        sizeBytes: null,
        contentType: null,
        lastModified: null,
      },
      {
        id: '3',
        path: 'alpha.txt',
        kind: 'file',
        sizeBytes: 0,
        contentType: null,
        lastModified: null,
      },
      {
        id: '4',
        path: 'alpha',
        kind: 'folder',
        sizeBytes: null,
        contentType: null,
        lastModified: null,
      },
    ];
    expect(sortedRows(unsorted).map((row) => row.path)).toEqual([
      'alpha',
      'beta',
      'alpha.txt',
      'zeta.txt',
    ]);
  });
});
