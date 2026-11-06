// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchDouble, jsonResponse, type RecordedRequest } from '@indx-workspace/sdk/testing';

import { FilesScreen, moveFolderChoices, type FileRow } from './resource-screens';

const FILE = {
  id: 'cmVwb3J0cy9xMy5wZGY',
  path: 'reports/q3.pdf',
  kind: 'file' as const,
  sizeBytes: 5,
  contentType: 'application/pdf',
  lastModified: '2026-11-04T10:00:00.000Z',
};
const FOLDER = {
  id: 'cmVwb3J0cy9vbGQ',
  path: 'reports/old',
  kind: 'folder' as const,
  sizeBytes: null,
  contentType: null,
  lastModified: null,
};

/** The `reports` folder holds one file and one subfolder; a move succeeds. */
function server() {
  return fetchDouble((request: RecordedRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/files') {
      return jsonResponse(200, { files: [FILE, FOLDER] });
    }
    return jsonResponse(200, { path: 'moved' });
  });
}

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

async function openReports(double: ReturnType<typeof server>): Promise<void> {
  vi.stubGlobal('fetch', double.fetch);
  window.history.replaceState({}, '', '/files?path=reports');
  act(() => root.render(<FilesScreen />));
  await vi.waitFor(() => expect(host.textContent).toContain('q3.pdf'));
}

function startRename(row: string): void {
  const tr = [...host.querySelectorAll('tr')].find((element) => element.textContent?.includes(row));
  const rename = [...(tr?.querySelectorAll('button') ?? [])].find(
    (element) => element.textContent?.trim() === 'Rename',
  );
  if (rename === undefined) throw new Error(`no Rename button on ${row}`);
  act(() => rename.click());
}

function renameInput(id: string): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(`input#rename-${id}`);
  if (input === null) throw new Error('no rename input');
  return input;
}

function folderSelect(): HTMLSelectElement {
  const select = host.querySelector('select');
  if (select === null) throw new Error('no folder choice');
  return select;
}

describe('the Files rename row (UX-27 in #2086)', () => {
  it('keeps the name being renamed visible and labels the field with it', async () => {
    await openReports(server());
    startRename('q3.pdf');

    const label = host.querySelector(`label[for="rename-${FILE.id}"]`);
    expect(label?.textContent).toBe('New path for q3.pdf');
    expect(label?.className ?? '').not.toContain('sr-only');
    expect(renameInput(FILE.id).value).toBe('reports/q3.pdf');
  });

  it('offers the known folders and moves the file into the chosen one', async () => {
    const double = server();
    await openReports(double);
    startRename('q3.pdf');

    const select = folderSelect();
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Home',
      'reports',
      'reports/old',
    ]);
    expect(select.value).toBe('reports');

    act(() => {
      select.value = 'reports/old';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(renameInput(FILE.id).value).toBe('reports/old/q3.pdf');

    act(() => renameInput(FILE.id).form?.requestSubmit());
    await vi.waitFor(() => expect(double.calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = double.calls.find((call) => call.method === 'PATCH');
    expect(JSON.stringify(patch?.json)).toContain('"reports/old/q3.pdf"');
  });

  it('keeps a typed name when a folder is chosen, and shows a typed unknown folder', async () => {
    await openReports(server());
    startRename('q3.pdf');
    const input = renameInput(FILE.id);

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'elsewhere/q4.pdf',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(folderSelect().value).toBe('elsewhere');

    act(() => {
      folderSelect().value = '';
      folderSelect().dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(renameInput(FILE.id).value).toBe('q4.pdf');
  });

  it('never offers a folder as a destination inside itself', async () => {
    await openReports(server());
    startRename('old');

    expect([...folderSelect().options].map((option) => option.value)).toEqual(['', 'reports']);
  });
});

describe('moveFolderChoices', () => {
  const folder = (path: string): FileRow => ({
    id: path,
    path,
    kind: 'folder',
    sizeBytes: null,
    contentType: null,
    lastModified: null,
  });

  it('lists Home, the breadcrumb and the subfolders once each, files left out', () => {
    expect(
      moveFolderChoices('a/b', [folder('a/b/c'), { ...FILE, path: 'a/b/x.txt' }], 'a/b/x.txt'),
    ).toEqual(['', 'a', 'a/b', 'a/b/c']);
    expect(moveFolderChoices('', [], 'x.txt')).toEqual(['']);
  });

  it('leaves out the moved folder itself, not a sibling sharing its prefix', () => {
    expect(moveFolderChoices('', [folder('a'), folder('ab')], 'a')).toEqual(['', 'ab']);
  });
});
