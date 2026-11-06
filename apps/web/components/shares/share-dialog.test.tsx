// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchDouble, jsonResponse } from '@indx-workspace/sdk/testing';

import { ShareDialog } from './share-dialog';

const AGENT = {
  type: 'agent',
  id: '77777777-7777-4777-8777-777777777777',
  label: 'Support',
} as const;
const TOKEN = 'pub_abcdefghijklmnopqrstuvwx';

function published(visibility: string, url?: string) {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    subjectType: 'agent',
    subjectId: AGENT.id,
    subjectLabel: AGENT.label,
    visibility,
    mode: 'definition',
    snapshot: null,
    include: {},
    budgetCapUsd: null,
    spentUsd: '0',
    stopped: false,
    expiresAt: null,
    revokedAt: null,
    suspendedAt: null,
    createdAt: '2026-11-04T10:00:00.000Z',
    ...(url === undefined ? {} : { url }),
  };
}

async function openDialog(): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(<ShareDialog subject={AGENT} />);
    await Promise.resolve();
  });
  await act(async () => {
    container.querySelector('button')?.click();
    await Promise.resolve();
  });
  return container;
}

function publishButton(container: HTMLElement): HTMLButtonElement {
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
  const last = buttons.at(-1);
  if (last === undefined) throw new Error('no publish button');
  return last;
}

async function choose(container: HTMLElement, visibility: string): Promise<void> {
  const select = container.querySelector<HTMLSelectElement>('[role="dialog"] select');
  if (select === null) throw new Error('no visibility select');
  await act(async () => {
    select.value = visibility;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

// UX-09 (#2086): "Copy link" copied `/p/<token>`, and showed on a choice that makes no link.
describe('ShareDialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('copies the full link, with the console origin, for "Anyone with the link"', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    vi.stubGlobal(
      'fetch',
      fetchDouble(() => jsonResponse(201, published('public', `/p/${TOKEN}`))).fetch,
    );
    const container = await openDialog();

    await choose(container, 'public');
    expect(publishButton(container).textContent).toBe('Copy link');
    act(() => {
      publishButton(container).click();
    });
    await settle();

    const expected = `${window.location.origin}/p/${TOKEN}`;
    expect(expected).toMatch(/^https?:\/\//u);
    expect(writeText).toHaveBeenCalledWith(expected);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      `Link copied: ${expected}`,
    );
  });

  it('shows the full link to copy by hand when the clipboard refuses', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.reject(new Error('no')));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    vi.stubGlobal(
      'fetch',
      fetchDouble(() => jsonResponse(201, published('public', `/p/${TOKEN}`))).fetch,
    );
    const container = await openDialog();
    await choose(container, 'public');
    act(() => {
      publishButton(container).click();
    });
    await settle();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      `${window.location.origin}/p/${TOKEN}`,
    );
  });

  it('publishes one share for two quick clicks', async () => {
    let answer: (response: Response) => void = () => undefined;
    const double = fetchDouble(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    vi.stubGlobal('fetch', double.fetch);
    const container = await openDialog();
    act(() => {
      publishButton(container).click();
      publishButton(container).click();
    });
    await settle();
    expect(publishButton(container).disabled).toBe(true);
    await act(async () => {
      answer(jsonResponse(201, published('workspace')));
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(double.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(publishButton(container).disabled).toBe(false);
  });

  it('says "Share", not "Copy link", for a choice that makes no link', async () => {
    vi.stubGlobal('fetch', fetchDouble(() => jsonResponse(201, published('workspace'))).fetch);
    const container = await openDialog();

    expect(publishButton(container).textContent).toBe('Share');
    act(() => {
      publishButton(container).click();
    });
    await settle();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Shared with the workspace.',
    );

    await choose(container, 'private');
    expect(publishButton(container).textContent).toBe('Share');
  });
});
