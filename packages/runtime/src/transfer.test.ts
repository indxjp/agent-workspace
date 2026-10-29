import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  ArchiveTooLargeError,
  ArchiveValidationError,
  archiveWorkspacePaths,
  bytesToStream,
  decodeUstar,
  encodeUstar,
  extractUstar,
  normalizeArchivePath,
  readStream,
} from './transfer.js';

function run(
  command: string,
  args: readonly string[],
  options: { readonly timeout?: number } = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      ...(options.timeout === undefined ? {} : { timeout: options.timeout, killSignal: 'SIGKILL' }),
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('POSIX ustar transfer', () => {
  it('round-trips names, modes, sizes, and exact bytes', () => {
    const entries = [
      { path: 'dir', type: 'directory' as const, mode: 0o755 },
      {
        path: 'dir/with-newline.txt',
        type: 'file' as const,
        mode: 0o640,
        data: Buffer.from('line\n'),
      },
      {
        path: 'without-newline.txt',
        type: 'file' as const,
        mode: 0o600,
        data: Buffer.from('tail'),
      },
    ];
    const decoded = decodeUstar(encodeUstar(entries));
    expect(
      decoded.map(({ path: entryPath, type, mode, data }) => ({
        path: entryPath,
        type,
        mode,
        data: data === undefined ? undefined : Buffer.from(data).toString('utf8'),
      })),
    ).toEqual([
      { path: 'dir', type: 'directory', mode: 0o755, data: undefined },
      { path: 'dir/with-newline.txt', type: 'file', mode: 0o640, data: 'line\n' },
      { path: 'without-newline.txt', type: 'file', mode: 0o600, data: 'tail' },
    ]);
  });

  it('emits an archive the system tar lists with the right paths, modes, and sizes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-ustar-list-'));
    const archive = path.join(root, 'out.tar');
    try {
      await writeFile(
        archive,
        encodeUstar([
          { path: 'folder', type: 'directory', mode: 0o755 },
          { path: 'folder/five.txt', type: 'file', mode: 0o640, data: Buffer.from('12345') },
        ]),
      );
      const listing = await run('tar', ['-tvf', archive]);
      expect(listing.code, listing.output).toBe(0);
      expect(listing.output).toContain('folder/');
      expect(listing.output).toContain('folder/five.txt');
      expect(listing.output).toMatch(/-rw-r-----[\s\S]*\s5\s/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('hydrates a system-tar archive and round-trips a tree byte-identically', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-ustar-roundtrip-'));
    const source = path.join(root, 'source');
    const hydrated = path.join(root, 'hydrated');
    const collected = path.join(root, 'collected');
    const archive = path.join(root, 'system.tar');
    try {
      await mkdir(path.join(source, 'nested'), { recursive: true });
      await writeFile(path.join(source, 'with.txt'), 'with newline\n');
      await writeFile(path.join(source, 'without.txt'), 'without newline');
      await writeFile(path.join(source, 'nested', 'binary.bin'), Buffer.from([0, 1, 2, 255]));
      const made = await run('tar', [
        '-cf',
        archive,
        '-C',
        source,
        'with.txt',
        'without.txt',
        'nested/binary.bin',
      ]);
      expect(made.code, made.output).toBe(0);
      await extractUstar(bytesToStream(await readFile(archive)), hydrated);

      const stream = await archiveWorkspacePaths(hydrated, [
        'with.txt',
        'without.txt',
        'nested/binary.bin',
      ]);
      await extractUstar(bytesToStream(await readStream(stream)), collected);
      for (const relative of ['with.txt', 'without.txt', 'nested/binary.bin']) {
        const original = await readFile(path.join(source, relative));
        const final = await readFile(path.join(collected, relative));
        expect(hash(final), relative).toBe(hash(original));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an existing leaf symlink without modifying its outside target', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-ustar-leaf-symlink-'));
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside.txt');
    const leaf = path.join(workspace, 'payload.txt');
    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(outside, 'outside must survive');
      await symlink(outside, leaf, 'file');
      const archive = encodeUstar([
        { path: 'payload.txt', type: 'file', mode: 0o600, data: Buffer.from('attacker data') },
      ]);

      await expect(extractUstar(bytesToStream(archive), workspace)).rejects.toThrow(/symlink/u);
      expect(await readFile(outside, 'utf8')).toBe('outside must survive');
      expect((await lstat(leaf)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('overwrites an existing regular file without leaving a backup on Windows', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-ustar-overwrite-'));
    const workspace = path.join(root, 'workspace');
    try {
      await mkdir(workspace);
      await writeFile(path.join(workspace, 'payload.txt'), 'old data');
      await extractUstar(
        bytesToStream(
          encodeUstar([
            { path: 'payload.txt', type: 'file', mode: 0o600, data: Buffer.from('new data') },
          ]),
        ),
        workspace,
      );

      expect(await readFile(path.join(workspace, 'payload.txt'), 'utf8')).toBe('new data');
      expect((await readdir(workspace)).filter((name) => /\.(?:bak|tmp)$/u.test(name))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an existing directory leaf symlink instead of materializing through it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-ustar-directory-symlink-'));
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(outside);
      await symlink(outside, path.join(workspace, 'linked'), 'dir');

      await expect(
        extractUstar(
          bytesToStream(encodeUstar([{ path: 'linked', type: 'directory', mode: 0o755 }])),
          workspace,
        ),
      ).rejects.toThrow(/symlink/u);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to collect through a linked parent directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-collect-parent-'));
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    try {
      await mkdir(workspace);
      await mkdir(outside);
      await writeFile(path.join(outside, 'secret.txt'), 'outside the workspace');
      await symlink(outside, path.join(workspace, 'outputs'), 'junction');

      const failure = await archiveWorkspacePaths(workspace, ['outputs/secret.txt']).then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(failure?.message).toMatch(/symlink parent is forbidden: outputs/u);
      expect(failure?.message).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    '../escape',
    '/absolute',
    'C:\\absolute',
    '%2e%2e/escape',
    '%252e%252e/escape',
    '%00',
    'a/%2500b',
  ])('refuses unsafe path %s', (unsafe) => {
    expect(() => normalizeArchivePath(unsafe)).toThrow(/unsafe archive path/u);
    expect(() => normalizeArchivePath(unsafe)).toThrow(ArchiveValidationError);
  });

  // @story US-STO-06
  it.each([
    ['a path encoded four times', '%2525252e%2525252e/x'],
    ['a drive letter exposed by ./', './C:/x'],
    ['a lower-case drive letter exposed by ./', './c:/'],
  ])('[US-STO-06][unit][run] refuses %s (%s)', (_name, unsafe) => {
    expect(() => normalizeArchivePath(unsafe)).toThrow(ArchiveValidationError);
  });

  it.each(['%00', '%2e%2e/x', 'a/%2500b', '%252e%252e/x', '../x', '/abs'])(
    'refuses the archive member %s on encode and decode',
    (unsafe) => {
      expect(() => encodeUstar([{ path: unsafe, type: 'file', mode: 0o600 }])).toThrow(
        ArchiveValidationError,
      );
      const forged = Buffer.from(encodeUstar([{ path: 'placeholder', type: 'file', mode: 0o600 }]));
      forged.fill(0, 0, 100);
      forged.write(unsafe, 0);
      forged.fill(0x20, 148, 156);
      const checksum = forged.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
      forged.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
      expect(() => decodeUstar(forged)).toThrow(ArchiveValidationError);
    },
  );

  it('reports a malformed header as an ArchiveValidationError', () => {
    const archive = encodeUstar([{ path: 'a.txt', type: 'file', mode: 0o600 }]);
    archive[148] = 0x39;
    expect(() => decodeUstar(archive)).toThrow(ArchiveValidationError);
  });

  it('keeps percent signs, percent escapes and backslashes in real names', async () => {
    const names = ['50%.txt', 'a%2Eb', ...(process.platform === 'win32' ? [] : ['a\\b'])];
    const decoded = decodeUstar(
      encodeUstar(names.map((name) => ({ path: `dir/${name}`, type: 'file', mode: 0o600 }))),
    );
    expect(decoded.map((entry) => entry.path)).toEqual(names.map((name) => `dir/${name}`));

    const root = await mkdtemp(path.join(tmpdir(), 'w3-literal-names-'));
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    try {
      await mkdir(path.join(source, 'dir'), { recursive: true });
      for (const name of names) await writeFile(path.join(source, 'dir', name), `data ${name}`);
      const archive = await readStream(await archiveWorkspacePaths(source, ['dir']));
      expect(decodeUstar(archive).map((entry) => entry.path)).toEqual([
        'dir',
        ...names.map((name) => `dir/${name}`).sort(),
      ]);
      await extractUstar(bytesToStream(archive), target);
      expect((await readdir(path.join(target, 'dir'))).sort()).toEqual([...names].sort());
      for (const name of names) {
        expect(await readFile(path.join(target, 'dir', name), 'utf8')).toBe(`data ${name}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // #1991 D1: ustar text fields end at NUL; trailing whitespace is part of the name.
  it('keeps trailing whitespace in names, so distinct names never collapse into one file', async () => {
    const longDirectory = `${'d'.repeat(100)} `;
    const names = ['report.txt', 'report.txt ', 'report.txt\u3000', `${longDirectory}/a.txt`];
    const entries = names.map((name) => ({
      path: name,
      type: 'file' as const,
      mode: 0o600,
      data: Buffer.from(`data ${name}`),
    }));
    const archive = encodeUstar(entries);
    expect(decodeUstar(archive).map((entry) => entry.path)).toEqual(names);

    const root = await mkdtemp(path.join(tmpdir(), 'w3-literal-whitespace-'));
    try {
      await extractUstar(bytesToStream(archive), root);
      for (const name of names) {
        expect(await readFile(path.join(root, name), 'utf8')).toBe(`data ${name}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // #1991 D2: a whole-archive decode budgets payload and members, not wire bytes.
  it('decodes within the payload and member budgets and refuses past either', () => {
    const archive = encodeUstar([
      { path: 'a.txt', type: 'file', mode: 0o600, data: Buffer.from('1234') },
      { path: 'b.txt', type: 'file', mode: 0o600, data: Buffer.from('5678') },
    ]);
    expect(decodeUstar(archive, { maxBytes: 8, maxMembers: 2 })).toHaveLength(2);
    expect(() => decodeUstar(archive, { maxBytes: 7 })).toThrow(ArchiveTooLargeError);
    expect(() => decodeUstar(archive, { maxMembers: 1 })).toThrow(ArchiveTooLargeError);
  });

  // #1991 D4: a leaf swapped for a FIFO after the inventory must not block the late open. A child
  // process makes the attempt; a regression blocks it in open(), so spawn kills it with SIGKILL.
  it.skipIf(process.platform === 'win32')(
    'refuses an output swapped for a FIFO after collection instead of blocking',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'w3-collect-fifo-'));
      try {
        await writeFile(path.join(root, 'out.txt'), 'regular');
        const transfer = new URL('./transfer.ts', import.meta.url).href;
        const script = [
          `const { archiveWorkspacePaths, readStream } = await import(${JSON.stringify(transfer)});`,
          `const { execFileSync } = await import('node:child_process');`,
          `const { unlink } = await import('node:fs/promises');`,
          `const leaf = ${JSON.stringify(path.join(root, 'out.txt'))};`,
          `const stream = await archiveWorkspacePaths(${JSON.stringify(root)}, ['out.txt']);`,
          `await unlink(leaf);`,
          `execFileSync('mkfifo', [leaf]);`,
          `await readStream(stream).then(() => console.log('read'), (e) => console.log(e.name));`,
        ].join('\n');
        const result = await run(process.execPath, ['--input-type=module', '--eval', script], {
          timeout: 3_000,
        });
        expect(result.output.trim().split('\n').at(-1), result.output).toBe(
          'ArchiveValidationError',
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('refuses to collect more than the byte budget and accepts exactly the budget', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-collect-cap-'));
    try {
      await writeFile(path.join(root, 'four.txt'), '1234');
      await writeFile(path.join(root, 'five.txt'), '12345');
      await expect(
        archiveWorkspacePaths(root, ['four.txt'], { maxBytes: 4 }),
      ).resolves.toBeDefined();
      await expect(archiveWorkspacePaths(root, ['five.txt'], { maxBytes: 4 })).rejects.toThrow(
        ArchiveTooLargeError,
      );
      await expect(
        archiveWorkspacePaths(root, ['four.txt', 'four.txt'], { maxBytes: 7 }),
      ).rejects.toThrow(ArchiveTooLargeError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
