// @vitest-environment happy-dom
import { createClient } from '@indx-workspace/sdk';
import { fetchDouble, jsonResponse, type FetchDouble } from '@indx-workspace/sdk/testing';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NewConnectionForm } from './new-connection-form';

/** UX-08 (#2086): a name with capitals was refused as "could not be saved", with no reason. */
const double: { current: FetchDouble } = {
  current: fetchDouble(() => jsonResponse(500, {})),
};
vi.mock('../../lib/browser-client', () => ({
  browserClient: () =>
    createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      fetch: (input, init) => double.current.fetch(input, init),
    }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;

afterEach(() => {
  document.body.replaceChildren();
});

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(<NewConnectionForm />);
    await Promise.resolve();
  });
}

function type(id: string, value: string): void {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
  if (input === null) throw new Error(`no #${id}`);
  const prototype = Object.getPrototypeOf(input) as object;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(): Promise<void> {
  await act(async () => {
    container.querySelector('form')?.requestSubmit();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

function alertText(): string | null {
  return container.querySelector('[role="alert"]')?.textContent ?? null;
}

describe('NewConnectionForm names the problem with a connection name', () => {
  it.each(['Sales', 'sales reports', '1-sales', 'sales_reports'])(
    'refuses %j before sending, and says what a name may contain',
    async (name) => {
      double.current = fetchDouble(() => jsonResponse(500, {}));
      await render();
      type('storage-name', name);
      type('storage-url', 's3://acme-bucket');
      type('storage-folders', 'reports');
      await submit();

      expect(double.current.calls).toHaveLength(0);
      expect(alertText()).toContain('Name: use lowercase letters, digits and hyphens');
    },
  );

  it('refuses a name shaped like a connection ID', async () => {
    double.current = fetchDouble(() => jsonResponse(500, {}));
    await render();
    type('storage-name', 'a1b2c3d4-0000-4000-8000-000000000001');
    type('storage-url', 's3://acme-bucket');
    type('storage-folders', 'reports');
    await submit();

    expect(double.current.calls).toHaveLength(0);
    expect(alertText()).toContain('looks like a connection ID');
  });

  it('sends a valid name to the server', async () => {
    double.current = fetchDouble(() =>
      jsonResponse(201, {
        id: '3f2b6c1e-8a4d-4f0e-9b57-2d1c0a9e7b11',
        name: 'sales-reports',
        provider: 's3',
        url: 's3://acme-bucket',
        allowedPrefixes: ['reports'],
        writeAllowed: false,
        hasCredential: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    await render();
    type('storage-name', '  sales-reports ');
    type('storage-url', 's3://acme-bucket');
    type('storage-folders', 'reports');
    await submit();

    // The save, then the test of what was saved (UX-07).
    expect(double.current.calls[0]?.url.pathname).toBe('/api/storage-connections');
    expect(double.current.calls[0]?.json).toMatchObject({ name: 'sales-reports' });
    expect(alertText()).toBeNull();
  });
});

const CONNECTION = {
  id: '3f2b6c1e-8a4d-4f0e-9b57-2d1c0a9e7b11',
  name: 'sales-reports',
  provider: 's3',
  url: 's3://acme-bucket',
  allowedPrefixes: ['reports'],
  writeAllowed: false,
  hasCredential: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** Save answers 201; the test answers `test`. */
function saveThenTest(test: () => Response): void {
  double.current = fetchDouble((request) =>
    request.url.pathname.endsWith('/test') ? test() : jsonResponse(201, CONNECTION),
  );
}

async function saveValid(): Promise<void> {
  await render();
  type('storage-name', 'sales-reports');
  type('storage-url', 's3://acme-bucket');
  type('storage-folders', 'reports');
  await submit();
}

function statusText(): string {
  return container.querySelector('[role="status"]')?.textContent ?? '';
}

function link(name: string): HTMLAnchorElement | null {
  return [...container.querySelectorAll('a')].find((anchor) => anchor.textContent === name) ?? null;
}

describe('NewConnectionForm saves and then tests the connection (UX-07, #2086)', () => {
  it('tests the saved connection with the stored key and says it works', async () => {
    saveThenTest(() => jsonResponse(200, { ok: true }));
    await saveValid();

    expect(double.current.calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      'POST /api/storage-connections',
      `POST /api/storage-connections/${CONNECTION.id}/test`,
    ]);
    expect(container.querySelector('h2')?.textContent).toBe('Saved sales-reports');
    expect(document.activeElement).toBe(container.querySelector('h2'));
    expect(statusText()).toBe('Saved and connected.');
    expect(link('Done')?.getAttribute('href')).toBe('/admin/storage');
    expect(link('Edit connection')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
  });

  it.each([
    [{ ok: false, code: 'forbidden' }, 'refused the credential', 'Check the credential'],
    [{ ok: false, code: 'not_found' }, 'was not found', 'Check the bucket or folder'],
    [{ ok: false, code: 'unreachable' }, 'did not answer', 'reachable'],
  ])(
    'keeps the connection, says why %j did not pass, and offers Edit',
    async (outcome, why, next) => {
      saveThenTest(() => jsonResponse(200, outcome));
      await saveValid();

      expect(statusText()).toContain('Saved, but the test did not pass.');
      expect(statusText()).toContain(why);
      expect(statusText()).toContain(next);
      expect(link('Edit connection')?.getAttribute('href')).toBe(`/admin/storage/${CONNECTION.id}`);
      expect(link('Back to Storage')?.getAttribute('href')).toBe('/admin/storage');
      expect(link('Done')).toBeNull();
    },
  );

  it('says a folder with no files may be misspelled, and offers Edit', async () => {
    saveThenTest(() => jsonResponse(200, { ok: true, emptyFolders: ['reprots'] }));
    await saveValid();

    expect(statusText()).toContain('Saved and connected, but no files were found under: reprots.');
    expect(statusText()).toContain('If a folder name is wrong, edit the connection.');
    expect(container.querySelector('[role="status"] p')?.className).toBe('text-warn');
    expect(link('Edit connection')).not.toBeNull();
    expect(link('Done')).toBeNull();
  });

  it('says it is saved when the test request itself fails', async () => {
    saveThenTest(() => jsonResponse(403, { type: 'about:blank', title: 'Forbidden', status: 403 }));
    await saveValid();

    expect(statusText()).toContain('Saved.');
    expect(statusText()).toContain('Test it again from Storage.');
    expect(link('Edit connection')).not.toBeNull();
  });

  it('shows the saved connection while the test runs', async () => {
    let answer: (response: Response) => void = () => undefined;
    double.current = fetchDouble((request) =>
      request.url.pathname.endsWith('/test')
        ? new Promise<Response>((resolve) => {
            answer = resolve;
          })
        : jsonResponse(201, CONNECTION),
    );
    await saveValid();

    expect(statusText()).toBe('Testing the connection…');
    expect(link('Back to Storage')).not.toBeNull();
    await act(async () => {
      answer(jsonResponse(200, { ok: true }));
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(statusText()).toBe('Saved and connected.');
  });

  it('does not test when the save fails', async () => {
    double.current = fetchDouble(() => jsonResponse(500, {}));
    await saveValid();

    expect(double.current.calls).toHaveLength(1);
    expect(alertText()).toContain('could not be saved');
    expect(container.querySelector('form')).not.toBeNull();
  });
});
