// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchDouble, jsonResponse, type RecordedRequest } from '@indx-workspace/sdk/testing';

import { emptyFolderText, FilesScreen } from './resource-screens';

const FILE = {
  id: 'cmVwb3J0LnBkZg',
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

/** A server whose `reports` folder holds one file and one empty folder; every other folder is empty. */
function server() {
  return fetchDouble((request: RecordedRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/files') {
      const path = request.url.searchParams.get('path') ?? '';
      return jsonResponse(200, { files: path === 'reports' ? [FILE, FOLDER] : [] });
    }
    return jsonResponse(500, {});
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

async function open(path: string, double = server()): Promise<typeof double> {
  vi.stubGlobal('fetch', double.fetch);
  window.history.replaceState({}, '', `/files?path=${encodeURIComponent(path)}`);
  act(() => root.render(<FilesScreen />));
  await vi.waitFor(() => expect(host.textContent).not.toContain('Loading files'));
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
  return double;
}

describe('emptyFolderText (UX-20 in #2086)', () => {
  it('tells an empty folder, a file and a missing folder apart by the parent’s rows', () => {
    const rows = [FILE, FOLDER] as const;
    expect(emptyFolderText('reports/old', rows)).toBe('This folder is empty.');
    expect(emptyFolderText('reports/q3.pdf', rows)).toBe(
      '"reports/q3.pdf" is a file, not a folder. Go up one folder to see it.',
    );
    expect(emptyFolderText('reports/gone', rows)).toBe(
      'There is no folder "reports/gone". It may have been moved, renamed or deleted.',
    );
  });
});

describe('FilesScreen says what an empty listing means', () => {
  it('a folder that exists and is empty', async () => {
    await open('reports/old');
    expect(host.textContent).toContain('This folder is empty.');
  });

  it('a link to a folder that no longer exists', async () => {
    await open('reports/gone');
    expect(host.textContent).toContain('There is no folder "reports/gone".');
    expect(host.textContent).not.toContain('This folder is empty.');
  });

  it('a link to a file', async () => {
    await open('reports/q3.pdf');
    expect(host.textContent).toContain('"reports/q3.pdf" is a file, not a folder.');
  });

  it('says nothing while the parent is being checked, not "This folder is empty."', async () => {
    const pending = fetchDouble((request: RecordedRequest) => {
      const path = request.url.searchParams.get('path') ?? '';
      return path === 'reports/gone'
        ? jsonResponse(200, { files: [] })
        : new Promise<Response>(() => undefined);
    });
    await open('reports/gone', pending);
    expect(pending.calls).toHaveLength(2);
    expect(host.textContent).not.toContain('This folder is empty.');
    expect(host.querySelector('p[role="status"]')?.textContent).toBe('');
  });

  it('the top folder, empty, without asking anything more', async () => {
    const double = await open('');
    expect(host.textContent).toContain('This folder is empty.');
    expect(double.calls).toHaveLength(1);
  });
});

describe('FilesScreen says why an empty file was not uploaded (UX-19 in #2086)', () => {
  it('names the file and sends nothing', async () => {
    const double = await open('');
    const input = host.querySelector<HTMLInputElement>('input[name="file"]');
    if (input === null) throw new Error('no file input');
    const empty = new File([], 'notes.txt', { type: 'text/plain' });
    const transfer = new DataTransfer();
    transfer.items.add(empty);
    input.files = transfer.files;
    await act(async () => {
      input.form?.requestSubmit();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      '"notes.txt" is empty (0 bytes), so it was not uploaded.',
    );
    expect(double.calls.map((call) => call.method)).toEqual(['GET']);
  });
});
