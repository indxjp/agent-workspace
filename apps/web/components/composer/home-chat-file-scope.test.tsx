// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { eventStreamResponse, fixtures, jsonResponse } from '@indx-workspace/sdk/testing';

import { HomeChat, type HomeChatProps } from './home-chat';
import type { ComposerAgent } from './model';

// RF-502 (#2089): what the home chat sends when files are picked in "+ Files".
const SESSION = '77777777-7777-4777-8777-777777777777';
const AGENT: ComposerAgent = {
  id: 'a',
  name: 'Research',
  detail: '',
  files: [
    { id: 'notes/q3.md', name: 'q3.md', detail: 'notes/q3.md · read-only' },
    { id: 'reports', name: 'reports/', detail: 'reports · read/write' },
  ],
  connectors: [],
  sandbox: 'Standard Sandbox',
  runTarget: { kind: 'runnable', source: 'workspace', connectionName: 'c', model: 'm' },
  drivableProviders: ['anthropic'],
};
const PROPS: HomeChatProps = {
  agents: { kind: 'agents', agents: [AGENT] },
  recent: [],
  user: { initials: 'A', name: 'alex@example.com' },
};

let sent: { url: string; body: unknown }[] = [];
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<HomeChat {...PROPS} />);
    await Promise.resolve();
  });
  return container;
}

async function type(textarea: HTMLTextAreaElement, text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      textarea,
      text,
    );
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

async function pick(container: HTMLElement, name: string): Promise<void> {
  const summary = container.querySelector<HTMLElement>('details[data-picker="files"] > summary');
  if (summary === null) throw new Error('no files picker');
  await press(summary);
  const option = [
    ...container.querySelectorAll<HTMLButtonElement>('details[data-picker="files"] button'),
  ].find((button) => button.textContent?.includes(name));
  if (option === undefined) throw new Error(`no option ${name}`);
  await press(option);
}

async function sendFirst(container: HTMLElement, text: string): Promise<void> {
  const box = container.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');
  if (box === null) throw new Error('no composer');
  await type(box, text);
  const send = container.querySelector<HTMLButtonElement>('[data-testid="composer-send"]');
  if (send === null) throw new Error('no Send');
  await press(send);
  await settle();
}

const runStarts = () => sent.filter((each) => each.url.endsWith('/api/agents/a/runs'));

describe('HomeChat "+ Files" narrows the chat (RF-502)', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    sent = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const text = request.method === 'POST' ? await request.clone().text() : '';
      sent.push({
        url: request.url,
        body: text === '' ? undefined : (JSON.parse(text) as unknown),
      });
      if (request.method === 'POST' && request.url.endsWith('/runs')) {
        return jsonResponse(202, {
          run: fixtures.run({ sessionId: SESSION }),
          events: `/api/runs/${fixtures.run().id}/events`,
        });
      }
      if (request.url.endsWith('/events')) return eventStreamResponse('event: done\ndata: {}\n\n');
      return new Promise<Response>(() => undefined);
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('sends the picked paths as fileScope with the first message and every follow-up', async () => {
    const container = await render();
    await pick(container, 'reports/');
    await sendFirst(container, 'Summarise the reports.');

    expect(runStarts()).toHaveLength(1);
    expect(runStarts()[0]?.body).toMatchObject({
      prompt: 'Summarise the reports.',
      fileScope: ['reports'],
    });

    const followUp = [...container.querySelectorAll('textarea')].find(
      (each) => each.getAttribute('data-testid') !== 'composer-input',
    );
    if (followUp === undefined) throw new Error('no follow-up box');
    await type(followUp, 'And the totals?');
    const submit =
      [...(followUp.parentElement?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (each) => each.textContent === 'Send',
      ) ?? null;
    if (submit === null) throw new Error('no follow-up Send');
    await press(submit);
    await settle();

    expect(runStarts()).toHaveLength(2);
    expect(runStarts()[1]?.body).toMatchObject({
      prompt: 'And the totals?',
      sessionId: SESSION,
      fileScope: ['reports'],
    });
  });

  it('sends no fileScope when nothing is picked, so the run keeps every grant', async () => {
    const container = await render();
    await sendFirst(container, 'Hello');

    expect(runStarts()).toHaveLength(1);
    expect(runStarts()[0]?.body).not.toHaveProperty('fileScope');
  });

  it('sends only what is still picked: a pick taken back is not sent', async () => {
    const container = await render();
    await pick(container, 'reports/');
    await pick(container, 'q3.md');
    await pick(container, 'reports/');
    await sendFirst(container, 'Read the note.');

    expect(runStarts()[0]?.body).toMatchObject({ fileScope: ['notes/q3.md'] });
  });
});
