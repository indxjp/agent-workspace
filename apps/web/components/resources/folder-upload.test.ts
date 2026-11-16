import { describe, expect, it } from 'vitest';

import { MAX_FILES_PER_UPLOAD, pickedFiles, readDropped, type DroppedItem } from './folder-upload';

const text = (name: string) => new File(['x'], name, { type: 'text/plain' });

/** A file entry as a browser hands one over; `fail` makes reading it fail. */
function fileEntry(name: string, fail = false) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (success: (file: File) => void, failure?: (error: unknown) => void) =>
      fail ? failure?.(new Error('NotReadableError')) : success(text(name)),
  };
}

/**
 * A folder entry whose reader answers `batchSize` children at a time, then an empty batch, as
 * Chrome's does (100 at a time). `fail` makes reading it fail.
 */
function folderEntry(name: string, children: readonly unknown[], batchSize = 100, fail = false) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let at = 0;
      return {
        readEntries: (success: (entries: unknown[]) => void, failure?: (e: unknown) => void) => {
          if (fail) {
            failure?.(new Error('NotReadableError'));
            return;
          }
          const batch = children.slice(at, at + batchSize);
          at += batch.length;
          success([...batch]);
        },
      };
    },
  };
}

const dropped = (...entries: unknown[]): DroppedItem[] =>
  entries.map((entry) => ({ entry: entry as DroppedItem['entry'], file: null }));

describe('readDropped', () => {
  it('reads a nested folder into files at their paths inside it, sorted', async () => {
    const read = await readDropped(
      dropped(
        folderEntry('photos', [
          fileEntry('b.jpg'),
          folderEntry('2026', [fileEntry('a.jpg'), fileEntry('議事録.txt')]),
        ]),
      ),
    );
    expect(read.files.map((upload) => upload.path)).toEqual([
      'photos/2026/a.jpg',
      'photos/2026/議事録.txt',
      'photos/b.jpg',
    ]);
    expect(read.files.map((upload) => upload.file.name)).toEqual(['a.jpg', '議事録.txt', 'b.jpg']);
    expect(read).toMatchObject({ emptyFolders: [], unreadable: [], tooMany: false });
  });

  it('keeps asking a folder reader until it answers an empty batch', async () => {
    const children = Array.from({ length: 250 }, (_, index) =>
      fileEntry(`f${String(index).padStart(3, '0')}.txt`),
    );
    const read = await readDropped(dropped(folderEntry('many', children, 100)));
    expect(read.files).toHaveLength(250);
    expect(read.files.at(-1)?.path).toBe('many/f249.txt');
  });

  it('names an empty folder, and does not call a folder with an empty folder in it empty', async () => {
    const read = await readDropped(
      dropped(
        folderEntry('top', [folderEntry('empty', []), folderEntry('full', [fileEntry('a')])]),
      ),
    );
    expect(read.emptyFolders).toEqual(['top/empty']);
    expect(read.files.map((upload) => upload.path)).toEqual(['top/full/a']);
  });

  it('names a folder or a file the browser could not read, and still reads the rest', async () => {
    const read = await readDropped(
      dropped(
        folderEntry('top', [
          folderEntry('locked', [fileEntry('x')], 100, true),
          fileEntry('gone.txt', true),
          fileEntry('ok.txt'),
        ]),
      ),
    );
    expect(read.unreadable).toEqual(['top/gone.txt', 'top/locked']);
    expect(read.files.map((upload) => upload.path)).toEqual(['top/ok.txt']);
  });

  it('takes a dropped file as itself, at its own name', async () => {
    const file = text('loose.txt');
    const read = await readDropped([{ entry: fileEntry('loose.txt'), file }]);
    expect(read.files).toEqual([{ file, path: 'loose.txt' }]);
  });

  it('stops reading past the limit and sends nothing', async () => {
    const children = Array.from({ length: 6 }, (_, index) => fileEntry(`f${String(index)}`));
    const exactly = await readDropped(dropped(folderEntry('top', children.slice(0, 5))), 5);
    expect(exactly.tooMany).toBe(false);
    expect(exactly.files).toHaveLength(5);
    const over = await readDropped(dropped(folderEntry('top', children)), 5);
    expect(over).toEqual({ files: [], emptyFolders: [], unreadable: [], tooMany: true });
  });

  it('has a limit of a thousand files by default', () => {
    expect(MAX_FILES_PER_UPLOAD).toBe(1000);
  });
});

describe('pickedFiles', () => {
  it("uses a folder pick's path inside the folder, and a lone file's name", () => {
    const inFolder = text('a.jpg');
    Object.defineProperty(inFolder, 'webkitRelativePath', { value: 'photos/2026/a.jpg' });
    const loose = text('b.txt');
    Object.defineProperty(loose, 'webkitRelativePath', { value: '' });
    expect(pickedFiles([inFolder, loose]).map((upload) => upload.path)).toEqual([
      'photos/2026/a.jpg',
      'b.txt',
    ]);
  });
});
