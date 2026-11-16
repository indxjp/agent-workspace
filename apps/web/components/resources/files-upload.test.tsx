// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SIGNED_UPLOAD_HARD_MAX_BYTES } from '@indx-workspace/contracts/files';
import { fetchDouble, jsonResponse, type RecordedRequest } from '@indx-workspace/sdk/testing';

import {
  droppedBatch,
  fileBatch,
  refusedBeforeUpload,
  uploadEach,
  uploadProblem,
  uploadStatus,
  type UploadItem,
} from './files-upload';
import { FilesScreen } from './resource-screens';
import { saidText, type Said } from './files-messages';

/** A line as English prints it. */
const said = (line: Said | null | undefined) => (line == null ? line : saidText(line));
/** Items with each reason as the line English prints. */
const plain = (items: readonly UploadItem[]) =>
  items.map(({ reason, ...rest }) =>
    reason === undefined ? rest : { ...rest, reason: said(reason) },
  );

const text = (name: string, body = 'x') => new File([body], name, { type: 'text/plain' });

/** A file that says it is `size` bytes without holding them. */
function sized(name: string, size: number): File {
  const file = text(name);
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('uploadEach (UX-16 in #2086)', () => {
  it('sends the files one after another and keeps going past a failure', async () => {
    const sent: string[] = [];
    const seen: (readonly UploadItem[])[] = [];
    const result = await uploadEach(
      fileBatch([text('a.txt'), text('b.txt'), text('c.txt')]),
      ({ file }) => {
        sent.push(file.name);
        return file.name === 'b.txt'
          ? Promise.reject(new Error('Upload returned 500.'))
          : Promise.resolve();
      },
      (items) => seen.push(items),
    );
    expect(sent).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(plain(result)).toEqual([
      { name: 'a.txt', state: 'done' },
      { name: 'b.txt', state: 'failed', reason: '"b.txt" was not uploaded: Upload returned 500.' },
      { name: 'c.txt', state: 'done' },
    ]);
    // Never two at once: while one is uploading, nothing after it has started.
    for (const items of seen) {
      expect(items.filter((item) => item.state === 'uploading').length).toBeLessThanOrEqual(1);
    }
    expect(seen.map((items) => uploadStatus(items))).toContain('Uploading 2 of 3: b.txt…');
  });

  it('keeps a reason that already names the file as it is', async () => {
    const [item] = await uploadEach(
      fileBatch([text('big.bin')]),
      () => Promise.reject(new Error('"big.bin" is too large to upload here.')),
      () => undefined,
    );
    expect(said(item?.reason)).toBe('"big.bin" is too large to upload here.');
  });

  it('sends neither an empty file nor one over the signed-upload maximum', async () => {
    const send = vi.fn(() => Promise.resolve());
    const result = await uploadEach(
      fileBatch([text('empty.txt', ''), sized('huge.iso', SIGNED_UPLOAD_HARD_MAX_BYTES + 1)]),
      send,
      () => undefined,
    );
    expect(send).not.toHaveBeenCalled();
    expect(result.map((item) => said(item.reason))).toEqual([
      '"empty.txt" is empty (0 bytes), so it was not uploaded.',
      '"huge.iso" is larger than the 5 GiB limit, so it was not uploaded.',
    ]);
  });

  it('names a folder the browser could not read as not uploaded', async () => {
    const result = await uploadEach(
      { files: [], unreadable: ['photos/locked'] },
      vi.fn(),
      () => undefined,
    );
    expect(plain(result)).toEqual([
      {
        name: 'photos/locked',
        state: 'failed',
        reason: 'The folder "photos/locked" could not be read, so it was not uploaded.',
      },
    ]);
  });
});

describe('refusedBeforeUpload', () => {
  it('lets through a file exactly at the maximum', () => {
    expect(refusedBeforeUpload(sized('max.bin', SIGNED_UPLOAD_HARD_MAX_BYTES))).toBeNull();
    expect(refusedBeforeUpload(sized('one.bin', 1))).toBeNull();
  });
});

describe('uploadProblem and uploadStatus', () => {
  const done: UploadItem = { name: 'a', state: 'done' };
  const failed: UploadItem = {
    name: 'b',
    state: 'failed',
    reason: [{ text: '"b" was not uploaded:' }, { text: 'x', english: true }],
  };

  it('says a lone failure in full and counts several', () => {
    expect(uploadProblem([done])).toBeNull();
    expect(said(uploadProblem([failed]))).toBe('"b" was not uploaded: x');
    expect(said(uploadProblem([done, failed, failed]))).toBe(
      '2 of 3 files were not uploaded. The list below says why.',
    );
  });

  it('says which file is going and, for several, how many finished', () => {
    expect(uploadStatus([])).toBeNull();
    expect(uploadStatus([{ name: '報告書.pdf', state: 'uploading' }])).toBe(
      'Uploading 報告書.pdf…',
    );
    expect(uploadStatus([done])).toBeNull();
    expect(uploadStatus([done, failed])).toBe('Finished: 1 of 2 files uploaded.');
    expect(uploadStatus([done, { name: 'c', state: 'waiting' }])).toBeNull();
  });
});

describe('droppedBatch', () => {
  it('takes the dropped files', async () => {
    const transfer = new DataTransfer();
    transfer.items.add(text('a.txt'));
    transfer.items.add(text('b.txt'));
    expect((await droppedBatch(transfer)).files.map((upload) => upload.path)).toEqual([
      'a.txt',
      'b.txt',
    ]);
  });

  it('reads a dropped folder instead of sending it as an empty file', async () => {
    const photo = text('a.jpg');
    const folder = {
      isDirectory: true,
      isFile: false,
      name: 'photos',
      createReader: () => {
        let read = false;
        return {
          readEntries: (done: (entries: unknown[]) => void) => {
            done(
              read
                ? []
                : [
                    {
                      isDirectory: false,
                      isFile: true,
                      name: 'a.jpg',
                      file: (f: (x: File) => void) => f(photo),
                    },
                  ],
            );
            read = true;
          },
        };
      },
    };
    const item = (entry: unknown, file: File | null) => ({
      kind: 'file',
      webkitGetAsEntry: () => entry,
      getAsFile: () => file,
    });
    const transfer = {
      items: [
        item(folder, text('photos', '')),
        item({ isDirectory: false, isFile: true, name: 'a.txt' }, text('a.txt')),
      ],
      files: [],
    };
    const batch = await droppedBatch(transfer as unknown as DataTransfer);
    expect(batch.files.map((upload) => upload.path)).toEqual(['a.txt', 'photos/a.jpg']);
    expect(batch.files[1]?.file).toBe(photo);
  });
});

// --- the screen --------------------------------------------------------------------------------

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

/** A server with an empty top folder; an upload of `bad.txt` answers 500, a later one is held. */
function server(hold?: Promise<void>) {
  return fetchDouble(async (request: RecordedRequest) => {
    if (request.method === 'GET') return jsonResponse(200, { files: [] });
    const path = decodeURIComponent(request.headers.get('x-file-path') ?? '');
    if (path === 'bad.txt') return jsonResponse(500, { error: { code: 'internal', message: 'x' } });
    if (hold !== undefined) await hold;
    return jsonResponse(201, {
      file: {
        id: path,
        path,
        kind: 'file',
        sizeBytes: 1,
        contentType: 'text/plain',
        lastModified: null,
      },
    });
  });
}

async function open(double: ReturnType<typeof server>) {
  vi.stubGlobal('fetch', double.fetch);
  window.history.replaceState({}, '', '/files');
  act(() => root.render(<FilesScreen />));
  await vi.waitFor(() => expect(host.textContent).toContain('This folder is empty.'));
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });

/**
 * A drag event as a browser sends it. happy-dom's `DataTransfer` lists a file's type as `""`
 * where a browser says `Files`, so the types are given here.
 */
function drag(type: 'dragover' | 'drop', files: DataTransfer): Event {
  const dataTransfer = {
    types: ['Files'],
    items: files.items,
    files: files.files,
    dropEffect: 'none',
  };
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer });
}

const uploads = (double: ReturnType<typeof server>) =>
  double.calls
    .filter((call) => call.method === 'POST')
    .map((call) => decodeURIComponent(call.headers.get('x-file-path') ?? ''));

describe('FilesScreen uploads several files (UX-16 in #2086)', () => {
  it('takes several picked files, uploads each, and says which one failed', async () => {
    const double = server();
    await open(double);
    const input = host.querySelector<HTMLInputElement>('input[name="file"]');
    if (input === null) throw new Error('no file input');
    expect(input.multiple).toBe(true);
    const transfer = new DataTransfer();
    for (const name of ['a.txt', 'bad.txt', '議事録.txt']) transfer.items.add(text(name));
    input.files = transfer.files;
    await act(async () => {
      input.form?.requestSubmit();
      await Promise.resolve();
    });
    await settle();
    await vi.waitFor(() =>
      expect(host.querySelector('[role="status"]')?.textContent).toBe(
        'Finished: 2 of 3 files uploaded.',
      ),
    );
    expect(uploads(double)).toEqual(['a.txt', 'bad.txt', '議事録.txt']);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      '1 of 3 files were not uploaded. The list below says why.',
    );
    const rows = Array.from(host.querySelectorAll('ul[aria-label="Upload results"] li'));
    expect(rows.map((row) => row.textContent)).toEqual([
      'a.txt: Uploaded',
      'bad.txt: Not uploaded — "bad.txt" was not uploaded: Upload returned 500.',
      '議事録.txt: Uploaded',
    ]);
  });

  it('shows which file of how many is going while it runs', async () => {
    let release = () => {};
    const double = server(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await open(double);
    const input = host.querySelector<HTMLInputElement>('input[name="file"]');
    if (input === null) throw new Error('no file input');
    const transfer = new DataTransfer();
    transfer.items.add(text('bad.txt'));
    transfer.items.add(text('held.txt'));
    input.files = transfer.files;
    await act(async () => {
      input.form?.requestSubmit();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(host.querySelector('[role="status"]')?.textContent).toBe(
        'Uploading 2 of 2: held.txt…',
      ),
    );
    const uploadHere = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Upload here',
    );
    expect(uploadHere?.disabled).toBe(true);
    release();
    await vi.waitFor(() =>
      expect(host.querySelector('[role="status"]')?.textContent).toBe(
        'Finished: 1 of 2 files uploaded.',
      ),
    );
  });

  it('uploads files dropped on the list and shows the drop state while dragging', async () => {
    const double = server();
    await open(double);
    // Dropped on the empty-folder line inside the list, which is how a drop reaches the zone.
    const zone = Array.from(host.querySelectorAll('p')).find(
      (element) => element.textContent === 'This folder is empty.',
    );
    if (zone === undefined) throw new Error('no list');
    const files = new DataTransfer();
    files.items.add(text('dropped.txt'));
    await act(async () => {
      zone.dispatchEvent(drag('dragover', files));
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Drop to upload to this folder.');
    await act(async () => {
      zone.dispatchEvent(drag('drop', files));
      await Promise.resolve();
    });
    await settle();
    await vi.waitFor(() => expect(uploads(double)).toEqual(['dropped.txt']));
    expect(host.textContent).not.toContain('Drop to upload to this folder.');
  });

  it('ignores a second drop while the first batch is still uploading', async () => {
    let release = () => undefined as void;
    const double = server(new Promise<void>((resolve) => (release = resolve)));
    await open(double);
    const zone = Array.from(host.querySelectorAll('p')).find(
      (element) => element.textContent === 'This folder is empty.',
    );
    if (zone === undefined) throw new Error('no list');
    const first = new DataTransfer();
    first.items.add(text('one.txt'));
    const second = new DataTransfer();
    second.items.add(text('two.txt'));
    // Both drops land before React renders `busy`, as two quick drops do.
    await act(async () => {
      zone.dispatchEvent(drag('drop', first));
      zone.dispatchEvent(drag('drop', second));
      await Promise.resolve();
    });
    release();
    await settle();
    await vi.waitFor(() => expect(uploads(double)).toEqual(['one.txt']));
  });

  it('swallows a file dropped outside the list, so the browser does not open it', async () => {
    const double = server();
    await open(double);
    const files = new DataTransfer();
    files.items.add(text('stray.txt'));
    const over = drag('dragover', files);
    const dropped = drag('drop', files);
    await act(async () => {
      document.body.dispatchEvent(over);
      document.body.dispatchEvent(dropped);
      await Promise.resolve();
    });
    await settle();
    expect(over.defaultPrevented).toBe(true);
    expect(dropped.defaultPrevented).toBe(true);
    expect(uploads(double)).toEqual([]);
    // Dragged text is not a file: the page leaves it to the browser.
    const words = Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
      dataTransfer: { types: ['text/plain'] },
    });
    await act(async () => {
      document.body.dispatchEvent(words);
      await Promise.resolve();
    });
    expect(words.defaultPrevented).toBe(false);
    // The upload picker takes a dropped file itself, so its drop keeps the browser's default.
    const input = host.querySelector<HTMLInputElement>('input[name="file"]');
    if (input === null) throw new Error('no file input');
    const onPicker = drag('drop', files);
    await act(async () => {
      input.dispatchEvent(onPicker);
      await Promise.resolve();
    });
    expect(onPicker.defaultPrevented).toBe(false);
  });
  it('refreshes the folder on screen when a batch ends, after the person opened another one', async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const row = (path: string, kind: 'file' | 'folder') => ({
      id: path,
      path,
      kind,
      sizeBytes: kind === 'file' ? 1 : null,
      contentType: kind === 'file' ? 'text/plain' : null,
      lastModified: null,
    });
    const double = fetchDouble(async (request: RecordedRequest) => {
      if (request.method === 'GET') {
        return jsonResponse(200, {
          files:
            request.url.searchParams.get('path') === 'reports'
              ? [row('reports/q3.txt', 'file')]
              : [row('reports', 'folder')],
        });
      }
      await hold;
      const path = decodeURIComponent(request.headers.get('x-file-path') ?? '');
      return jsonResponse(201, { file: row(path, 'file') });
    });
    vi.stubGlobal('fetch', double.fetch);
    window.history.replaceState({}, '', '/files');
    act(() => root.render(<FilesScreen />));
    const folder = () =>
      Array.from(host.querySelectorAll('button')).find(
        (button) => button.textContent === 'reports/',
      );
    await vi.waitFor(() => expect(folder()).toBeDefined());
    const input = host.querySelector<HTMLInputElement>('input[name="file"]');
    if (input === null) throw new Error('no file input');
    const transfer = new DataTransfer();
    transfer.items.add(text('held.txt'));
    transfer.items.add(text('also-held.txt'));
    input.files = transfer.files;
    await act(async () => {
      input.form?.requestSubmit();
      await Promise.resolve();
    });
    // While the files upload into the top folder, the person opens reports/.
    act(() => folder()?.click());
    await vi.waitFor(() => expect(host.textContent).toContain('q3.txt'));
    release();
    await vi.waitFor(() =>
      expect(host.querySelector('[role="status"]')?.textContent).toBe(
        'Finished: 2 of 2 files uploaded.',
      ),
    );
    await settle();
    // The listing is reports/ — the folder on screen — not the top folder the batch started in.
    expect(host.textContent).toContain('q3.txt');
    expect(folder()).toBeUndefined();
    const listed = double.calls
      .filter((call) => call.method === 'GET')
      .map((call) => call.url.searchParams.get('path') ?? '');
    expect(listed.at(-1)).toBe('reports');
  });
});

describe('FilesScreen uploads a folder (#2086 Upload)', () => {
  /** A server that records uploads and folder creations; `conflict` folders answer 409. */
  function folderServer(conflict: readonly string[] = [], refuse: readonly string[] = []) {
    return fetchDouble((request: RecordedRequest) => {
      if (request.method === 'GET') return Promise.resolve(jsonResponse(200, { files: [] }));
      const folder = request.headers.get('x-folder-path');
      if (folder !== null) {
        const path = decodeURIComponent(folder);
        if (conflict.includes(path))
          return Promise.resolve(
            jsonResponse(409, {
              error: { code: 'name_conflict', message: `${path} already exists.` },
            }),
          );
        if (refuse.includes(path))
          return Promise.resolve(
            jsonResponse(400, {
              error: { code: 'invalid_path', message: '"path" is not a valid folder path.' },
            }),
          );
        return Promise.resolve(
          jsonResponse(201, {
            file: {
              id: path,
              path,
              kind: 'folder',
              sizeBytes: null,
              contentType: null,
              lastModified: null,
            },
          }),
        );
      }
      const path = decodeURIComponent(request.headers.get('x-file-path') ?? '');
      return Promise.resolve(
        jsonResponse(201, {
          file: {
            id: path,
            path,
            kind: 'file',
            sizeBytes: 1,
            contentType: 'text/plain',
            lastModified: null,
          },
        }),
      );
    });
  }
  const sentFiles = (double: ReturnType<typeof folderServer>) =>
    double.calls
      .map((call) => call.headers.get('x-file-path'))
      .filter((value): value is string => value !== null)
      .map((value) => decodeURIComponent(value));
  const folders = (double: ReturnType<typeof folderServer>) =>
    double.calls
      .map((call) => call.headers.get('x-folder-path'))
      .filter((value): value is string => value !== null)
      .map((value) => decodeURIComponent(value));

  it('has a folder picker that sends each file at its path inside the folder', async () => {
    const double = folderServer();
    await open(double);
    const input = host.querySelector<HTMLInputElement>('input[name="folder"]');
    if (input === null) throw new Error('no folder input');
    expect(input.hasAttribute('webkitdirectory')).toBe(true);
    expect(input.labels?.[0]?.textContent).toContain('Upload a folder and everything in it');
    const transfer = new DataTransfer();
    for (const path of ['photos/a.jpg', 'photos/2026/b.jpg']) {
      const file = text(path.split('/').at(-1) ?? path);
      Object.defineProperty(file, 'webkitRelativePath', { value: path });
      transfer.items.add(file);
    }
    input.files = transfer.files;
    await act(async () => {
      input.form?.requestSubmit();
      await Promise.resolve();
    });
    await settle();
    await vi.waitFor(() =>
      expect(host.querySelector('[role="status"]')?.textContent).toBe(
        'Finished: 2 of 2 files uploaded.',
      ),
    );
    expect(sentFiles(double)).toEqual(['photos/a.jpg', 'photos/2026/b.jpg']);
    const rows = Array.from(host.querySelectorAll('ul[aria-label="Upload results"] li'));
    expect(rows.map((row) => row.textContent)).toEqual([
      'photos/a.jpg: Uploaded',
      'photos/2026/b.jpg: Uploaded',
    ]);
  });

  it('uploads a dropped folder, creates its empty folders, and takes one already there', async () => {
    const double = folderServer(['top/kept']);
    await open(double);
    const zone = Array.from(host.querySelectorAll('p')).find(
      (element) => element.textContent === 'This folder is empty.',
    );
    if (zone === undefined) throw new Error('no list');
    const entry = (name: string, children: unknown[] | null) =>
      children === null
        ? {
            isFile: true,
            isDirectory: false,
            name,
            file: (ok: (f: File) => void) => ok(text(name)),
          }
        : {
            isFile: false,
            isDirectory: true,
            name,
            createReader: () => {
              let done = false;
              return {
                readEntries: (ok: (e: unknown[]) => void) => {
                  ok(done ? [] : children);
                  done = true;
                },
              };
            },
          };
    const top = entry('top', [entry('a.txt', null), entry('empty', []), entry('kept', [])]);
    const dataTransfer = {
      types: ['Files'],
      items: [{ kind: 'file', webkitGetAsEntry: () => top, getAsFile: () => text('top', '') }],
      files: [],
      dropEffect: 'none',
    };
    await act(async () => {
      zone.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }),
      );
      await Promise.resolve();
    });
    await settle();
    await vi.waitFor(() => expect(folders(double)).toEqual(['top/empty', 'top/kept']));
    expect(sentFiles(double)).toEqual(['top/a.txt']);
    await settle();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('says an empty folder the server refused to create', async () => {
    const double = folderServer([], ['top/bad']);
    await open(double);
    const zone = Array.from(host.querySelectorAll('p')).find(
      (element) => element.textContent === 'This folder is empty.',
    );
    if (zone === undefined) throw new Error('no list');
    const bad = {
      isFile: false,
      isDirectory: true,
      name: 'bad',
      createReader: () => ({ readEntries: (ok: (e: unknown[]) => void) => ok([]) }),
    };
    const top = {
      isFile: false,
      isDirectory: true,
      name: 'top',
      createReader: () => {
        let done = false;
        return {
          readEntries: (ok: (e: unknown[]) => void) => {
            ok(
              done
                ? []
                : [
                    bad,
                    {
                      isFile: true,
                      isDirectory: false,
                      name: 'a.txt',
                      file: (got: (f: File) => void) => got(text('a.txt')),
                    },
                  ],
            );
            done = true;
          },
        };
      },
    };
    const dataTransfer = {
      types: ['Files'],
      items: [{ kind: 'file', webkitGetAsEntry: () => top, getAsFile: () => null }],
      files: [],
      dropEffect: 'none',
    };
    await act(async () => {
      zone.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }),
      );
      await Promise.resolve();
    });
    await settle();
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(
        '1 of 2 files were not uploaded. The list below says why.',
      ),
    );
    const rows = Array.from(host.querySelectorAll('ul[aria-label="Upload results"] li'));
    expect(rows.map((row) => row.textContent)).toEqual([
      'top/a.txt: Uploaded',
      'top/bad/: Not uploaded — The empty folder "top/bad" was not created: "path" is not a valid folder path.',
    ]);
  });

  it('refuses a pick of more than a thousand files and sends nothing', async () => {
    const double = folderServer();
    await open(double);
    const input = host.querySelector<HTMLInputElement>('input[name="folder"]');
    if (input === null) throw new Error('no folder input');
    const transfer = new DataTransfer();
    for (let index = 0; index < 1001; index += 1) transfer.items.add(text(`f${String(index)}.txt`));
    input.files = transfer.files;
    await act(async () => {
      input.form?.requestSubmit();
      await Promise.resolve();
    });
    await settle();
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(
        'This upload has more than 1000 files, so nothing was uploaded. Upload a smaller folder, or its folders one at a time.',
      ),
    );
    expect(sentFiles(double)).toEqual([]);
  });
});
