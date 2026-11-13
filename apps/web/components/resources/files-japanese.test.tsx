// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchDouble, jsonResponse, type RecordedRequest } from '@indx-workspace/sdk/testing';

import { emptyFolderText } from './file-browser-model';
import { filesStrings, type FilesStrings } from './files-messages';
import { uploadEach, uploadStatus } from './files-upload';
import { FileAssignments } from '../agents/resource-editor';
import { agentDetailStrings } from '../agents/agent-detail-messages';
import { FilePicker, FilesScreen } from './resource-screens';

// UX-15 in #2086: the Files screen and its picker in the reader's language.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every word a `FilesStrings` holds, keyed by its path; functions are called with samples. */
function flatten(strings: FilesStrings): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (prefix: string, value: unknown) => {
    if (typeof value === 'string') out.set(prefix, value);
    else if (typeof value === 'function')
      out.set(prefix, (value as (...samples: string[]) => string)('X', 'Y', 'Z'));
    else
      for (const [key, inner] of Object.entries(value as Record<string, unknown>))
        visit(prefix === '' ? key : `${prefix}.${key}`, inner);
  };
  visit('', strings);
  return out;
}

const en = filesStrings('en');
const ja = filesStrings('ja');

/** Words English leaves empty on purpose: a lead it never prints. */
const EMPTY_IN_ENGLISH = new Set([
  'leads.list',
  'leads.rename',
  'leads.delete',
  'leads.createFolder',
  'leads.upload',
  'notUploadedNamed',
]);

describe('filesStrings', () => {
  it('has a Japanese word for every English one, and none is the English word', () => {
    const english = flatten(en);
    const japanese = flatten(ja);
    expect([...japanese.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, word] of japanese) {
      expect(word, key).not.toBe('');
      expect(word, key).not.toBe(english.get(key));
      if (EMPTY_IN_ENGLISH.has(key)) expect(english.get(key), key).toBe('');
      else expect(english.get(key), key).not.toBe('');
    }
  });

  it('keeps the English the screen always printed, word for word', () => {
    expect(Object.fromEntries(flatten(en))).toEqual({
      title: 'Files',
      description: 'Browse workspace folders, upload inputs, and manage stored outputs.',
      loading: 'Loading files…',
      uploadLabel: 'Upload files to this folder',
      uploadButton: 'Upload here',
      uploadFolderLabel: 'Upload a folder and everything in it',
      uploadFolderButton: 'Upload folder here',
      grantHintBefore: 'Agents see a file only after it is granted. Add',
      grantHintAfter: "to the agent's definition. Chat attachments are not supported yet.",
      newFolderLabel: 'New folder name',
      newFolderPlaceholder: 'reports',
      newFolderButton: 'Create folder here',
      folderNameIsName: 'A folder name is a single name, not a path.',
      breadcrumb: 'Folder breadcrumb',
      home: 'Home',
      back: 'Back',
      'columns.select': 'Select',
      'columns.name': 'Name',
      'columns.type': 'Type',
      'columns.size': 'Size',
      'columns.contentType': 'Content type',
      'columns.modified': 'Modified',
      'columns.actions': 'Actions',
      'kind.file': 'file',
      'kind.folder': 'folder',
      selectRow: 'Select X',
      download: 'Download',
      rename: 'Rename',
      delete: 'Delete',
      newPathFor: 'New path for',
      moveToFolder: 'Move to folder',
      save: 'Save',
      cancel: 'Cancel',
      emptyFolder: 'This folder is empty.',
      isAFile: '"X" is a file, not a folder. Go up one folder to see it.',
      noSuchFolder: 'There is no folder "X". It may have been moved, renamed or deleted.',
      confirmDeleteFolder:
        'Delete "X"? If it contains anything you will be asked to confirm removing it too.',
      confirmDeleteFile: 'Delete "X"? This cannot be undone.',
      confirmNotEmpty: '"X" is not empty. Delete it and everything inside it?',
      staleList: 'The list could not be refreshed, so it may be out of date.',
      'leads.list': '',
      'leads.rename': '',
      'leads.delete': '',
      'leads.createFolder': '',
      'leads.upload': '',
      emptyFile: '"X" is empty (0 bytes), so it was not uploaded.',
      overHardLimit: '"X" is larger than the Y GiB limit, so it was not uploaded.',
      folderUnreadable: 'The folder "X" could not be read, so it was not uploaded.',
      folderNotCreated: 'The empty folder "X" was not created:',
      tooManyFiles:
        'This upload has more than X files, so nothing was uploaded. Upload a smaller folder, or its folders one at a time.',
      notUploaded: '"X" was not uploaded:',
      notUploadedNamed: '',
      overDeployment:
        '"X" is Y, more than this deployment accepts. Files up to Z always upload here.',
      uploadReturned: 'Upload returned X.',
      moveUnfinished:
        'Move did not finish: X of Y items moved; the rest are still at the old location.',
      deleteUnfinished: 'Delete did not finish: X removed, Y still present. Try again.',
      someNotUploaded: 'X of Y files were not uploaded. The list below says why.',
      uploadingOne: 'Uploading X…',
      uploadingOf: 'Uploading X of Y: Z…',
      finished: 'Finished: X of Y files uploaded.',
      'state.waiting': 'Waiting',
      'state.uploading': 'Uploading…',
      'state.done': 'Uploaded',
      'state.failed': 'Not uploaded',
      uploadResults: 'Upload results',
      dropWait: 'Wait for the current upload to finish.',
      dropHere: 'Drop to upload to this folder.',
    });
  });
});

describe('the Files helpers in Japanese', () => {
  it('says why an empty listing is empty', () => {
    expect(emptyFolderText('a', [{ path: 'a', kind: 'folder' }], ja)).toBe(ja.emptyFolder);
    expect(emptyFolderText('a', [{ path: 'a', kind: 'file' }], ja)).toBe(ja.isAFile('a'));
    expect(emptyFolderText('a', [], ja)).toBe(ja.noSuchFolder('a'));
  });

  it('words upload lines in Japanese and keeps the server sentence English', async () => {
    const result = await uploadEach(
      {
        files: [
          { file: new File(['x'], 'a.txt'), path: 'a.txt' },
          { file: new File([], 'empty.txt'), path: 'empty.txt' },
        ],
        unreadable: ['photos'],
      },
      () => Promise.reject(new Error('Bucket refused the write.')),
      () => undefined,
      ja,
    );
    expect(result.map((item) => item.reason)).toEqual([
      [{ text: ja.folderUnreadable('photos') }],
      [{ text: ja.notUploaded('a.txt') }, { text: 'Bucket refused the write.', english: true }],
      [{ text: ja.emptyFile('empty.txt') }],
    ]);
    expect(uploadStatus(result, ja)).toBe(ja.finished('0', '3'));
  });
});

// --- rendered screens ------------------------------------------------------------------------

const FILE = {
  id: 'cmVwb3J0LnBkZg',
  path: 'report.pdf',
  kind: 'file',
  sizeBytes: 5,
  contentType: 'application/pdf',
  lastModified: '2026-11-04T10:00:00.000Z',
};
const FOLDER = {
  id: 'YXJjaGl2ZQ',
  path: 'archive',
  kind: 'folder',
  sizeBytes: null,
  contentType: null,
  lastModified: null,
};

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  window.history.replaceState({}, '', '/files');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

function server(answer: (request: RecordedRequest) => Response | undefined = () => undefined) {
  return fetchDouble(
    (request: RecordedRequest) =>
      answer(request) ??
      (request.method === 'GET' && request.url.pathname === '/api/files'
        ? jsonResponse(200, { files: [FILE, FOLDER] })
        : jsonResponse(500, { error: { code: 'unexpected', message: 'Unexpected call.' } })),
  );
}

/** English words of these screens a Japanese reader must not see (short words would match names). */
const ENGLISH_WORDS = [...flatten(en).entries()]
  .filter(([key, word]) => word.length > 3 && !key.startsWith('kind.'))
  .map(([, word]) => word.replace(/ X…?$| X$|X/gu, '').trim())
  .filter((word) => word.length > 3);

/** Every English word of this screen found on screen: text, accessible names and placeholders. */
function englishLeft(): string[] {
  const seen = [
    host.textContent ?? '',
    ...[...host.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label')),
    ...[...host.querySelectorAll('[placeholder]')].map((node) => node.getAttribute('placeholder')),
  ].join('\n');
  return ENGLISH_WORDS.filter((word) => seen.includes(word));
}

function button(row: string, name: string): HTMLButtonElement {
  const cell = [...host.querySelectorAll('tr')].find((tr) => tr.textContent?.includes(row));
  const found = [...(cell?.querySelectorAll('button') ?? [])].find(
    (element) => element.textContent?.trim() === name,
  );
  if (found === undefined) throw new Error(`no ${name} button on ${row}`);
  return found;
}

const alert = () => host.querySelector('[role="alert"]');

describe('FilesScreen in Japanese', () => {
  it('shows the screen in Japanese with no English word of its own left', async () => {
    vi.stubGlobal('fetch', server().fetch);
    act(() => root.render(<FilesScreen locale="ja" />));
    await vi.waitFor(() => expect(host.textContent).toContain('report.pdf'));

    expect(host.querySelector('[lang="ja"]')).not.toBeNull();
    expect(host.querySelector('h1')?.textContent).toBe(ja.title);
    const headers = [...host.querySelectorAll('th')].map((th) => th.textContent);
    expect(headers).toEqual([
      ja.columns.name,
      ja.columns.type,
      ja.columns.size,
      ja.columns.contentType,
      ja.columns.modified,
      ja.columns.actions,
    ]);
    const archiveRow = [...host.querySelectorAll('tr')].find((tr) =>
      tr.textContent?.includes('archive/'),
    );
    expect(archiveRow?.querySelectorAll('td')[1]?.textContent).toBe(ja.kind.folder);
    expect(host.querySelector('nav')?.getAttribute('aria-label')).toBe(ja.breadcrumb);
    expect(host.querySelector('input[name="name"]')?.getAttribute('placeholder')).toBe(
      ja.newFolderPlaceholder,
    );
    expect(englishLeft()).toEqual([]);

    act(() => button('report.pdf', ja.rename).click());
    expect(host.textContent).toContain(ja.newPathFor);
    expect(host.textContent).toContain(ja.moveToFolder);
    expect(englishLeft()).toEqual([]);
  });

  it('leads a server refusal in Japanese and keeps its sentence English', async () => {
    vi.stubGlobal('confirm', () => true);
    const double = server((request) =>
      request.method === 'DELETE'
        ? jsonResponse(403, { error: { code: 'forbidden', message: 'You cannot delete this.' } })
        : undefined,
    );
    vi.stubGlobal('fetch', double.fetch);
    act(() => root.render(<FilesScreen locale="ja" />));
    await vi.waitFor(() => expect(host.textContent).toContain('report.pdf'));

    act(() => button('report.pdf', ja.delete).click());
    await settle();

    expect(alert()?.textContent).toBe(`${ja.leads.delete} You cannot delete this.`);
    expect(alert()?.querySelector('[lang="en"]')?.textContent).toBe(' You cannot delete this.');
  });

  it('says in Japanese that the list may be out of date when the reload fails too', async () => {
    vi.stubGlobal('confirm', () => true);
    let lists = 0;
    const double = fetchDouble((request: RecordedRequest) => {
      if (request.method === 'GET' && request.url.pathname === '/api/files') {
        lists += 1;
        return lists === 1
          ? jsonResponse(200, { files: [FILE, FOLDER] })
          : jsonResponse(503, { error: { code: 'unavailable', message: 'Try again.' } });
      }
      return jsonResponse(403, { error: { code: 'forbidden', message: 'No.' } });
    });
    vi.stubGlobal('fetch', double.fetch);
    act(() => root.render(<FilesScreen locale="ja" />));
    await vi.waitFor(() => expect(host.textContent).toContain('report.pdf'));

    act(() => button('report.pdf', ja.delete).click());
    await settle();
    expect(alert()?.textContent).toBe(`${ja.leads.delete} No. ${ja.staleList}`);
  });

  it('says a part-way delete in Japanese, with nothing marked English', async () => {
    vi.stubGlobal('confirm', () => true);
    const double = server((request) =>
      request.method === 'DELETE'
        ? jsonResponse(200, {
            status: 'partial',
            deleted: ['archive/a.txt'],
            remaining: ['archive/b.txt', 'archive'],
          })
        : undefined,
    );
    vi.stubGlobal('fetch', double.fetch);
    act(() => root.render(<FilesScreen locale="ja" />));
    await vi.waitFor(() => expect(host.textContent).toContain('report.pdf'));

    act(() => button('archive', ja.delete).click());
    await settle();

    expect(alert()?.textContent).toBe(ja.deleteUnfinished('1', '2'));
    expect(alert()?.querySelector('[lang="en"]')).toBeNull();
  });

  it('asks the delete questions in Japanese', async () => {
    const asked: string[] = [];
    vi.stubGlobal('confirm', (question: string) => {
      asked.push(question);
      return false;
    });
    vi.stubGlobal('fetch', server().fetch);
    act(() => root.render(<FilesScreen locale="ja" />));
    await vi.waitFor(() => expect(host.textContent).toContain('report.pdf'));

    act(() => button('report.pdf', ja.delete).click());
    act(() => button('archive', ja.delete).click());
    expect(asked).toEqual([ja.confirmDeleteFile('report.pdf'), ja.confirmDeleteFolder('archive')]);
  });

  it('refuses a folder path as a name in Japanese', async () => {
    vi.stubGlobal('fetch', server().fetch);
    act(() => root.render(<FilesScreen locale="ja" />));
    await vi.waitFor(() => expect(host.textContent).toContain('report.pdf'));

    const input = host.querySelector<HTMLInputElement>('input[name="name"]');
    if (input === null) throw new Error('no folder name input');
    input.value = 'a/b';
    act(() => input.form?.requestSubmit());
    await settle();
    expect(alert()?.textContent).toBe(ja.folderNameIsName);
  });

  it('leads a failed listing in Japanese', async () => {
    vi.stubGlobal(
      'fetch',
      server(() => jsonResponse(503, { error: { code: 'unavailable', message: 'Try again.' } }))
        .fetch,
    );
    act(() => root.render(<FilesScreen locale="ja" />));
    await vi.waitFor(() => expect(alert()).not.toBeNull());
    expect(alert()?.textContent).toBe(`${ja.leads.list} Try again.`);
    expect(alert()?.querySelector('[lang="en"]')?.textContent).toBe(' Try again.');
  });
});

describe('FilePicker in Japanese', () => {
  it('shows the picker in Japanese with no English word of its own left', async () => {
    vi.stubGlobal('fetch', server().fetch);
    act(() => root.render(<FilePicker onChange={() => undefined} locale="ja" />));
    await vi.waitFor(() => expect(host.textContent).toContain('report.pdf'));

    expect(host.firstElementChild?.getAttribute('lang')).toBe('ja');
    expect(host.querySelector('th .sr-only')?.textContent).toBe(ja.columns.select);
    expect(host.querySelector('input[type="checkbox"]')?.getAttribute('aria-label')).toBe(
      ja.selectRow('archive'),
    );
    expect(englishLeft()).toEqual([]);
  });

  it('stays English without a locale', async () => {
    vi.stubGlobal('fetch', server().fetch);
    act(() => root.render(<FilePicker onChange={() => undefined} />));
    await vi.waitFor(() => expect(host.textContent).toContain('report.pdf'));
    expect(host.querySelector('th .sr-only')?.textContent).toBe('Select');
    expect(host.querySelector('input[type="checkbox"]')?.getAttribute('aria-label')).toBe(
      'Select archive',
    );
  });
});

describe('uploading on the Japanese Files screen', () => {
  it('says each file and the count in Japanese, the server sentence kept English', async () => {
    const double = fetchDouble((request: RecordedRequest) => {
      if (request.method === 'GET') return jsonResponse(200, { files: [] });
      const path = decodeURIComponent(request.headers.get('x-file-path') ?? '');
      if (path === 'bad.txt') {
        return jsonResponse(507, { error: { code: 'storage_full', message: 'Storage is full.' } });
      }
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
    vi.stubGlobal('fetch', double.fetch);
    act(() => root.render(<FilesScreen locale="ja" />));
    await vi.waitFor(() => expect(host.textContent).toContain(ja.emptyFolder));

    const input = host.querySelector<HTMLInputElement>('input[name="file"]');
    if (input === null) throw new Error('no file input');
    const transfer = new DataTransfer();
    for (const name of ['a.txt', 'bad.txt']) transfer.items.add(new File(['x'], name));
    input.files = transfer.files;
    await act(async () => {
      input.form?.requestSubmit();
      await Promise.resolve();
    });
    await settle();
    await vi.waitFor(() =>
      expect(host.querySelector('[role="status"]')?.textContent).toBe(ja.finished('1', '2')),
    );
    expect(alert()?.textContent).toBe(ja.someNotUploaded('1', '2'));
    const list = host.querySelector(`ul[aria-label="${ja.uploadResults}"]`);
    const rows = [...(list?.querySelectorAll('li') ?? [])].map((row) => row.textContent);
    expect(rows).toEqual([
      `a.txt: ${ja.state.done}`,
      `bad.txt: ${ja.state.failed} — ${ja.notUploaded('bad.txt')} ${ja.uploadReturned('507')}`,
    ]);
    expect(englishLeft()).toEqual([]);
  });
});

describe("agent detail's file browser in Japanese", () => {
  it("opens the picker in the reader's language", async () => {
    vi.stubGlobal('fetch', server().fetch);
    const words = agentDetailStrings('ja').editor;
    act(() =>
      root.render(
        <FileAssignments
          files={[]}
          catalog={null}
          writeFilesAllowed={false}
          onChange={() => undefined}
          locale="ja"
        />,
      ),
    );
    const open = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === words.addFiles,
    );
    if (open === undefined) throw new Error('no browse button');
    act(() => open.click());
    await vi.waitFor(() => expect(host.textContent).toContain('report.pdf'));
    expect(host.querySelector('th .sr-only')?.textContent).toBe(ja.columns.select);
    expect(host.querySelector('nav')?.getAttribute('aria-label')).toBe(ja.breadcrumb);
  });
});
