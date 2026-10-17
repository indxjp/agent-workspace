import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  formatBytes,
  measureTree,
  rankBySize,
  renderReport,
} from '../../scripts/measure/install-weight.mjs';

describe('install weight helpers', () => {
  it('ranks by summed size, largest first, ties by name, and limits', () => {
    const ranked = rankBySize(
      [
        { name: 'b', bytes: 10 },
        { name: 'a', bytes: 10 },
        { name: 'big', bytes: 30 },
        { name: 'a', bytes: 5 },
      ],
      3,
    );
    expect(ranked).toEqual([
      { name: 'big', bytes: 30, copies: 1 },
      { name: 'a', bytes: 15, copies: 2 },
      { name: 'b', bytes: 10, copies: 1 },
    ]);
    expect(rankBySize([{ name: 'a', bytes: 1 }], 0)).toEqual([]);
  });

  it('formats bytes', () => {
    expect(formatBytes(2048)).toBe('2.0 kB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('counts scoped and nested copies, and leaves nested files out of the parent', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'install-weight-test-'));
    try {
      const write = (file: string, text: string): void => {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), text);
      };
      write('a/index.js', '12345');
      write('a/node_modules/c/index.js', '12');
      write('@s/b/index.js', '123');
      write('.bin/x', 'ignored');
      const sorted = measureTree(root).sort((x, y) => x.name.localeCompare(y.name));
      expect(sorted).toEqual([
        { name: '@s/b', bytes: 3 },
        { name: 'a', bytes: 5 },
        { name: 'c', bytes: 2 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not swallow a read error inside a nested node_modules', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'install-weight-test-'));
    try {
      mkdirSync(path.join(root, 'a'), { recursive: true });
      writeFileSync(path.join(root, 'a', 'node_modules'), 'not a directory');
      expect(() => measureTree(root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renders the count, size, wall time, provenance and the ranked table', () => {
    const text = renderReport({
      how: 'HOW',
      host: 'HOST',
      packages: [
        { name: 'x', bytes: 1024 },
        { name: 'y', bytes: 2048 },
      ],
      seconds: 12.34,
      date: '2026-10-04',
    });
    expect(text).toContain('Measured 2026-10-04. HOW');
    expect(text).toContain('Host: HOST');
    expect(text).toContain('| Packages installed (copies) | 2 |');
    expect(text).toContain('| 12.3 s |');
    expect(text).toContain('| 1 | `y` | 2.0 kB | 1 |');
  });
});
