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

    expect(double.current.calls).toHaveLength(1);
    expect(double.current.calls[0]?.json).toMatchObject({ name: 'sales-reports' });
    expect(alertText()).toBeNull();
  });
});
