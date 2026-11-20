import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXIT_CODE } from '../output.js';

import { exportTs, markdown, project, versioned } from './agents-export.test-support.js';

/** Makes one file operation fail, by the path it names, to prove the export leaves nothing behind. */
const diskFault = vi.hoisted(() => ({
  fails: null as ((operation: string, source: string, destination: string) => boolean) | null,
  /** The `code` the failure carries; `EIO` when unset. */
  code: undefined as string | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const check = (operation: string, source: unknown, destination: unknown): Promise<void> =>
    diskFault.fails?.(operation, String(source), String(destination)) === true
      ? Promise.reject(Object.assign(new Error('disk fault'), { code: diskFault.code ?? 'EIO' }))
      : Promise.resolve();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await check('writeFile', args[0], args[0]);
      return actual.writeFile(...args);
    },
    link: async (source: string, destination: string) => {
      await check('link', source, destination);
      return actual.link(source, destination);
    },
    rename: async (source: string, destination: string) => {
      await check('rename', source, destination);
      return actual.rename(source, destination);
    },
  };
});

// `aw check` and `aw push` run the real project loader, a forked Node process.
vi.setConfig({ testTimeout: 30_000 });

describe('aw agents export --format ts, when a write fails part-way', () => {
  const endsWith = (file: string, name: string) => path.basename(file) === name;
  afterEach(() => {
    diskFault.fails = null;
    diskFault.code = undefined;
  });

  it('[US-BLD-06][api][cli] leaves no file, no directory and no temporary directory behind', async () => {
    const out = await project();
    diskFault.fails = (operation, _source, destination) =>
      operation === 'writeFile' && endsWith(destination, 'summariser.md');
    const failed = await exportTs(out, versioned(['v1'], 1));
    expect(failed.code).toBe(EXIT_CODE.problem);
    expect(failed.stderr).toContain('could not write');
    expect(failed.stdout).not.toContain('wrote ');
    expect(await readdir(out)).toEqual([]);
  });

  it('removes the files already moved into place, and the directory it made', async () => {
    const out = await project();
    diskFault.fails = (operation, _source, destination) =>
      operation === 'link' && endsWith(destination, 'summariser.md');
    const failed = await exportTs(out, versioned(['v1'], 1));
    expect(failed.code).toBe(EXIT_CODE.problem);
    expect(failed.stderr).toContain(`could not write ${markdown(out)}`);
    expect(await readdir(out)).toEqual([]);
  });

  it('keeps the files --force was replacing as they were', async () => {
    const out = await project({
      'agents/summariser.ts': 'old ts',
      'agents/summariser.md': 'old',
      'agents/other.md': 'untouched',
    });
    diskFault.fails = (operation, source, destination) =>
      operation === 'rename' &&
      endsWith(destination, 'summariser.md') &&
      source.includes('.aw-export-') &&
      source.includes(`${path.sep}new${path.sep}`);
    const failed = await exportTs(out, versioned(['v1'], 1), '--force');
    expect(failed.code).toBe(EXIT_CODE.problem);
    expect(failed.stderr).not.toContain('could not restore');
    expect(await readFile(path.join(out, 'agents', 'summariser.ts'), 'utf8')).toBe('old ts');
    expect(await readFile(markdown(out), 'utf8')).toBe('old');
    expect((await readdir(path.join(out, 'agents'))).sort()).toEqual([
      'other.md',
      'summariser.md',
      'summariser.ts',
    ]);
    expect(await readdir(out)).toEqual(['agents']);
  });

  it('keeps the temporary directory with the originals when it could not put them back', async () => {
    const out = await project({
      'agents/summariser.ts': 'old ts',
      'agents/summariser.md': 'old',
    });
    diskFault.fails = (operation, source, destination) =>
      operation === 'rename' &&
      endsWith(destination, 'summariser.md') &&
      (source.includes(`${path.sep}new${path.sep}`) ||
        source.includes(`${path.sep}displaced${path.sep}`));
    const failed = await exportTs(out, versioned(['v1'], 1), '--force');
    expect(failed.code).toBe(EXIT_CODE.problem);
    expect(failed.stderr).toContain(`could not restore ${markdown(out)}`);
    const [staging] = (await readdir(out)).filter((name) => name.startsWith('.aw-export-'));
    expect(staging).toBeDefined();
    expect(failed.stderr).toContain(path.join(out, staging ?? ''));
    // The only copy of the original .md is the displaced file in that directory.
    const kept = await readdir(path.join(out, staging ?? '', 'displaced'));
    const contents = await Promise.all(
      kept.map((name) => readFile(path.join(out, staging ?? '', 'displaced', name), 'utf8')),
    );
    expect(contents).toContain('old');
  });

  it.each([['EXDEV'], ['EPERM'], ['ENOTSUP']])(
    'falls back to a copy when a hard link fails with %s',
    async (code) => {
      const out = await project();
      diskFault.code = code;
      diskFault.fails = (operation) => operation === 'link';
      const done = await exportTs(out, versioned(['v1'], 1));
      expect(done.code).toBe(EXIT_CODE.ok);
      expect(await readFile(markdown(out), 'utf8')).toBe('v1');
      expect(await readdir(out)).toEqual(['agents']);
    },
  );

  it('falls back to a copy when a rename crosses devices, with --force', async () => {
    const out = await project({ 'agents/summariser.md': 'old' });
    diskFault.code = 'EXDEV';
    diskFault.fails = (operation) => operation === 'rename';
    const done = await exportTs(out, versioned(['v1'], 1), '--force');
    expect(done.code).toBe(EXIT_CODE.ok);
    expect(await readFile(markdown(out), 'utf8')).toBe('v1');
    expect(await readdir(out)).toEqual(['agents']);
  });

  it('does not fall back for a link that fails because the file exists', async () => {
    const out = await project();
    diskFault.code = 'EEXIST';
    diskFault.fails = (operation, _source, destination) =>
      operation === 'link' && endsWith(destination, 'summariser.md');
    const failed = await exportTs(out, versioned(['v1'], 1));
    expect(failed.code).toBe(EXIT_CODE.problem);
    expect(await readdir(out)).toEqual([]);
  });

  it('does not replace a directory, even with --force', async () => {
    const out = await project({ 'agents/summariser.md/keep.txt': 'mine' });
    const failed = await exportTs(out, versioned(['v1'], 1), '--force');
    expect(failed.code).toBe(EXIT_CODE.problem);
    expect(failed.stderr).toContain(`could not write ${markdown(out)}`);
    expect(await readFile(path.join(markdown(out), 'keep.txt'), 'utf8')).toBe('mine');
    expect(await readdir(path.join(out, 'agents'))).toEqual(['summariser.md']);
  });
});
