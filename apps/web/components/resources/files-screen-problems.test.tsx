// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchDouble, jsonResponse, type RecordedRequest } from '@indx-workspace/sdk/testing';

import { FilesScreen } from './resource-screens';

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

/** The server: lists the two rows, and answers every rename and delete with `refusal`. */
function server(refusal: Response) {
  return fetchDouble((request: RecordedRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/files') {
      return jsonResponse(200, { files: [FILE, FOLDER] });
    }
    return refusal.clone();
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
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function render(double: ReturnType<typeof fetchDouble>): Promise<void> {
  vi.stubGlobal('fetch', double.fetch);
  act(() => root.render(<FilesScreen />));
  await vi.waitFor(() => expect(host.textContent).toContain('report.pdf'));
}

function button(row: string, name: string): HTMLButtonElement {
  const cell = [...host.querySelectorAll('tr')].find((tr) => tr.textContent?.includes(row));
  const found = [...(cell?.querySelectorAll('button') ?? [])].find(
    (element) => element.textContent?.trim() === name,
  );
  if (found === undefined) throw new Error(`no ${name} button on ${row}`);
  return found;
}

function alertText(): string | null {
  return host.querySelector('[role="alert"]')?.textContent ?? null;
}

describe('FilesScreen keeps a refusal on screen after the list reloads (#2088)', () => {
  it('shows why a rename was refused', async () => {
    const double = server(
      jsonResponse(409, {
        error: { code: 'name_conflict', message: 'archive already exists.' },
      }),
    );
    await render(double);

    act(() => button('report.pdf', 'Rename').click());
    const input = host.querySelector<HTMLInputElement>('input#rename-cmVwb3J0LnBkZg');
    if (input === null) throw new Error('no rename input');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'archive',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => input.form?.requestSubmit());
    await settle();

    expect(double.calls.map((call) => call.method)).toEqual(['GET', 'PATCH', 'GET']);
    expect(alertText()).toContain('archive already exists.');
    // The listing was read again, so it is not called out of date.
    expect(alertText()).not.toContain('could not be refreshed');
  });

  it('shows why a delete was refused', async () => {
    vi.stubGlobal('confirm', () => true);
    const double = server(
      jsonResponse(403, { error: { code: 'forbidden', message: 'You cannot delete this.' } }),
    );
    await render(double);

    act(() => button('report.pdf', 'Delete').click());
    await settle();

    expect(double.calls.map((call) => call.method)).toEqual(['GET', 'DELETE', 'GET']);
    expect(alertText()).toContain('You cannot delete this.');
  });

  it('still shows the refusal when the reload after it fails too', async () => {
    let lists = 0;
    const double = fetchDouble((request: RecordedRequest) => {
      if (request.method === 'GET' && request.url.pathname === '/api/files') {
        lists += 1;
        return lists === 1
          ? jsonResponse(200, { files: [FILE, FOLDER] })
          : jsonResponse(503, { error: { code: 'unavailable', message: 'Try again.' } });
      }
      return jsonResponse(409, {
        error: { code: 'name_conflict', message: 'archive already exists.' },
      });
    });
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      vi.stubGlobal('confirm', () => true);
      await render(double);
      act(() => button('report.pdf', 'Delete').click());
      await settle();
      expect(double.calls.map((call) => call.method)).toEqual(['GET', 'DELETE', 'GET']);
      expect(alertText()).toContain(
        'archive already exists. The list could not be refreshed, so it may be out of date.',
      );
      expect(host.textContent).toContain('report.pdf');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]);
  });

  it('shows that a folder delete stopped part-way', async () => {
    vi.stubGlobal('confirm', () => true);
    const double = server(
      jsonResponse(200, {
        status: 'partial',
        deleted: ['archive/a.txt'],
        remaining: ['archive/b.txt', 'archive'],
      }),
    );
    await render(double);

    act(() => button('archive', 'Delete').click());
    await settle();

    expect(alertText()).toContain('Delete did not finish: 1 removed, 2 still present.');
  });
});
