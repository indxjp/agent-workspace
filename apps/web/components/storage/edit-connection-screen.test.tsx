// @vitest-environment happy-dom
import { createClient, type StorageConnectionResource } from '@indx-workspace/sdk';
import { fetchDouble, jsonResponse, type FetchDouble } from '@indx-workspace/sdk/testing';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EditConnectionScreen } from './edit-connection-screen';

/**
 * The edit page in a DOM: what the delete dialog does to the page behind it (#1835, STO-508).
 * Focus order, the Tab cycle and Escape are covered by `tests/browser/storage-connections.spec.mjs`.
 */
const CONNECTION: StorageConnectionResource = {
  id: '3f2b6c1e-8a4d-4f0e-9b57-2d1c0a9e7b11',
  name: 'acme-data',
  provider: 's3',
  url: 's3://acme-bucket',
  allowedPrefixes: ['reports'],
  writeAllowed: false,
  hasCredential: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const double: { current: FetchDouble } = {
  current: fetchDouble(() => jsonResponse(200, CONNECTION)),
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

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
  document.body.replaceChildren();
});

/** The screen beside a stand-in for the shell's sidebar, as the layout renders it. */
async function mountScreen(): Promise<{ host: HTMLElement; sidebar: HTMLElement }> {
  const sidebar = document.createElement('nav');
  sidebar.append(Object.assign(document.createElement('a'), { href: '/agents' }));
  const host = document.createElement('div');
  document.body.append(sidebar, host);
  const root = createRoot(host);
  act(() => {
    root.render(<EditConnectionScreen id={CONNECTION.id} />);
  });
  unmount = () => {
    act(() => {
      root.unmount();
    });
  };
  await settle();
  return { host, sidebar };
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === name,
  );
  if (found === undefined) throw new Error(`No button named ${name}`);
  return found;
}

function click(target: HTMLElement) {
  act(() => {
    target.click();
  });
}

/** True when the element or one of its ancestors is inert. */
const isInert = (element: Element) => element.closest('[inert]') !== null;

describe('the delete dialog', () => {
  it('makes everything behind it inert, and only that, while it is open', async () => {
    const { host, sidebar } = await mountScreen();
    const trigger = button('Delete this connection');

    click(trigger);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(isInert(sidebar)).toBe(true);
    expect(isInert(trigger)).toBe(true);
    expect(isInert(host.querySelector('form') ?? host)).toBe(true);
    expect(isInert(dialog ?? host)).toBe(false);
  });

  it('gives the page back, and focus to its trigger, when it closes', async () => {
    const { host, sidebar } = await mountScreen();
    const trigger = button('Delete this connection');

    click(trigger);
    click(button('Cancel'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelectorAll('[inert]')).toHaveLength(0);
    expect(isInert(sidebar)).toBe(false);
    expect(isInert(host)).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('leaves an element that was inert before it opened inert after it closes', async () => {
    const { sidebar } = await mountScreen();
    sidebar.setAttribute('inert', '');

    click(button('Delete this connection'));
    click(button('Cancel'));
    expect(sidebar.hasAttribute('inert')).toBe(true);
  });

  it('gives the page back when the delete is refused', async () => {
    double.current = fetchDouble((request) =>
      request.method === 'DELETE'
        ? jsonResponse(409, {
            error: { code: 'storage_connection_in_use', message: 'In use.' },
          })
        : jsonResponse(200, CONNECTION),
    );
    const { sidebar } = await mountScreen();

    click(button('Delete this connection'));
    click(button('Delete connection'));
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(isInert(sidebar)).toBe(false);
    expect(document.querySelectorAll('[inert]')).toHaveLength(0);
    expect(document.activeElement?.getAttribute('role')).toBe('alert');
  });
});

/** Type into the input a `<label>` names, the way React sees a keystroke. */
function type(label: string, text: string) {
  const named = [...document.querySelectorAll('label')].find((candidate) =>
    candidate.textContent?.trim().startsWith(label),
  );
  const input = named?.htmlFor ? document.getElementById(named.htmlFor) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error(`No input labelled ${label}`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('a credential sent with Save changes', () => {
  it('reaches the update, then is nowhere in the page, the URL, storage or the console', async () => {
    const secret = 'sEcReT-0123456789-abcdefghij';
    const moved = { ...CONNECTION, url: 's3://moved-bucket' };
    double.current = fetchDouble((request) =>
      jsonResponse(200, request.method === 'PATCH' ? moved : CONNECTION),
    );
    const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method),
    );
    await mountScreen();

    type('URL', moved.url);
    type('Access key ID', 'AKIA-TEST');
    type('Secret access key', secret);
    click(button('Save changes'));
    await settle();

    const update = double.current.calls.find((call) => call.method === 'PATCH');
    expect(JSON.stringify(update?.json)).toContain(secret);
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Changes saved.');
    for (const input of document.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
      expect(input.value).toBe('');
    }
    const surfaces = [
      document.documentElement.outerHTML,
      window.location.href,
      JSON.stringify({ ...localStorage }),
      JSON.stringify({ ...sessionStorage }),
      JSON.stringify(logged.flatMap((spy) => spy.mock.calls)),
    ].join('\n');
    expect(surfaces).not.toContain(secret);
    for (const spy of logged) spy.mockRestore();
  });
});
