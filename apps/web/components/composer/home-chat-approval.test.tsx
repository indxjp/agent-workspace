// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { eventStreamResponse, fixtures, jsonResponse } from '@indx-workspace/sdk/testing';

import { MOCKUP_RUN } from '../run/mockup-fixture';
import { HomeChat, type HomeChatProps } from './home-chat';

/**
 * Issue #1490: a run that pauses on a tool call (ADR-0145) shows Approve / Reject under its
 * transcript when the caller has no prompt of its own, and a decision's continuation run is
 * followed into the same transcript.
 */
const ENGINE = 'claude-agent-sdk';
const PAUSED = 'run-paused';
const CONTINUATION = '88888888-8888-4888-8888-888888888888';

const frame = (event: string, id: number, data: unknown): string =>
  `event: ${event}\nid: ${String(id)}\ndata: ${JSON.stringify(data)}\n\n`;
const DONE = 'event: done\ndata: {}\n\n';

const PAUSE_STREAM =
  frame('agent.approval.requested', 1, {
    frame: 'agent.approval.requested',
    engine: ENGINE,
    raw: null,
    toolCallId: 't1',
    toolName: 'mcp__crm__send_mail',
    canonicalCall: '{"to":"boss@example.com"}',
  }) +
  frame('run.status', 2, { status: 'awaiting_approval', error: null }) +
  DONE;

const CONTINUATION_STREAM =
  frame('agent.message', 1, {
    frame: 'agent.message',
    engine: ENGINE,
    raw: { type: 'assistant' },
    messageId: 'm1',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'The mail has been sent.' }],
  }) +
  frame('run.status', 2, { status: 'completed', error: null }) +
  DONE;

const PROPS: HomeChatProps = {
  agents: {
    kind: 'agents',
    agents: [
      {
        id: 'a',
        name: 'Mailer',
        detail: '',
        files: [],
        connectors: [],
        sandbox: 'Standard Sandbox',
        runTarget: { kind: 'runnable', source: 'workspace', connectionName: 'c', model: 'm' },
        drivableProviders: ['anthropic'],
      },
    ],
  },
  recent: [],
  user: { initials: 'A', name: 'alex@example.com' },
  agent: { id: 'a', locked: true },
};

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

let sent: Sent[];
let decision: () => Response | Promise<Response>;
let continuation: () => Response | Promise<Response>;
let lastRoot: Root | null = null;

function route(url: string, method: string): Response | Promise<Response> {
  if (url.endsWith(`/api/runs/${PAUSED}/events`)) return eventStreamResponse(PAUSE_STREAM);
  if (url.endsWith(`/api/runs/${CONTINUATION}/events`)) return continuation();
  if (method === 'POST' && url.endsWith(`/api/runs/${PAUSED}/approval`)) return decision();
  return new Promise<Response>(() => undefined);
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(props: Partial<HomeChatProps> = {}): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  lastRoot = root;
  const render = async (nonce: number) => {
    await act(async () => {
      root.render(
        <HomeChat {...PROPS} run={MOCKUP_RUN} {...props} follow={{ runId: PAUSED, nonce }} />,
      );
      await Promise.resolve();
    });
  };
  await render(0);
  await render(1);
  await settle();
  return container;
}

async function click(container: HTMLElement, name: string): Promise<void> {
  await act(async () => {
    button(container, name).click();
    await Promise.resolve();
  });
  await settle();
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

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((each) => each.textContent === name);
  if (found === undefined) throw new Error(`no ${name} button`);
  return found;
}

describe('HomeChat approval prompt (#1490)', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    sent = [];
    continuation = () => eventStreamResponse(CONTINUATION_STREAM);
    decision = () =>
      jsonResponse(202, {
        run: fixtures.run({ id: CONTINUATION }),
        events: `/api/runs/${CONTINUATION}/events`,
      });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const text = request.method === 'POST' ? await request.clone().text() : '';
      sent.push({
        url: request.url,
        method: request.method,
        body: text === '' ? undefined : (JSON.parse(text) as unknown),
      });
      return route(request.url, request.method);
    });
  });

  afterEach(() => {
    act(() => lastRoot?.unmount());
    lastRoot = null;
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('shows the paused call with Approve and Reject when the caller has no prompt of its own', async () => {
    const container = await open();

    const group = container.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toBe(
      'The agent is waiting for your approval to use mcp__crm__send_mail',
    );
    expect(container.textContent).toContain('{"to":"boss@example.com"}');
    expect(button(container, 'Approve').disabled).toBe(false);
    expect(button(container, 'Reject').disabled).toBe(false);
  });

  it('leaves a caller-supplied prompt in charge, as the Builder needs', async () => {
    const container = await open({ approval: null });

    expect(container.querySelector('[role="group"]')).toBeNull();
    expect(container.textContent).not.toContain('Approve');
  });

  it('approves, then follows the continuation into the same transcript and retires the prompt', async () => {
    const container = await open();

    await act(async () => {
      button(container, 'Approve').click();
      await Promise.resolve();
    });
    await settle();

    expect(sent.find((each) => each.url.endsWith('/approval'))?.body).toEqual({
      decision: 'approve',
    });
    expect(sent.some((each) => each.url.endsWith(`/api/runs/${CONTINUATION}/events`))).toBe(true);
    expect(container.textContent).toContain('The mail has been sent.');
    expect(container.querySelector('[role="group"]')).toBeNull();
  });

  it('sends a typed comment with a reject, and no comment when it is blank', async () => {
    const container = await open();
    const textarea = container.querySelector('textarea[maxlength="1000"]');
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('no comment box');

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        'Wrong recipient.',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      button(container, 'Reject').click();
      await Promise.resolve();
    });
    await settle();

    expect(sent.find((each) => each.url.endsWith('/approval'))?.body).toEqual({
      decision: 'reject',
      comment: 'Wrong recipient.',
    });
  });

  it('names a final refusal in plain words and closes the buttons, since no retry can succeed', async () => {
    decision = () =>
      jsonResponse(409, {
        error: { code: 'approval_already_decided', message: 'This approval was already decided.' },
      });
    const container = await open();

    await click(container, 'Approve');

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'This request has already been decided.',
    );
    expect(sent.filter((each) => each.url.endsWith('/approval'))).toHaveLength(1);
    expect(button(container, 'Approve').disabled).toBe(true);
    expect(button(container, 'Reject').disabled).toBe(true);
  });

  it('keeps the buttons open after a failure a retry can fix', async () => {
    decision = () => Promise.reject(new TypeError('Failed to fetch'));
    const container = await open();

    await click(container, 'Approve');

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'The decision could not be sent. Try again.',
    );
    expect(button(container, 'Approve').disabled).toBe(false);

    // And the retry is really sent.
    await click(container, 'Approve');
    expect(sent.filter((each) => each.url.endsWith('/approval'))).toHaveLength(2);
  });

  it('sends one decision for two clicks in the same tick', async () => {
    let answer: (response: Response) => void = () => undefined;
    decision = () => new Promise<Response>((resolve) => (answer = resolve));
    const container = await open();

    const approve = button(container, 'Approve');
    await act(async () => {
      approve.click();
      approve.click();
      await Promise.resolve();
    });
    await settle();
    answer(
      jsonResponse(202, {
        run: fixtures.run({ id: CONTINUATION }),
        events: `/api/runs/${CONTINUATION}/events`,
      }),
    );
    await settle();

    expect(sent.filter((each) => each.url.endsWith('/approval'))).toHaveLength(1);
  });

  it('holds a follow-up while the card asks, and lets it go once the request has ended for good', async () => {
    let answer: (response: Response) => void = () => undefined;
    decision = () => new Promise<Response>((resolve) => (answer = resolve));
    const container = await open();
    const followUp = container.querySelector('textarea[aria-label="Ask a follow-up"]');
    if (!(followUp instanceof HTMLTextAreaElement)) throw new Error('no follow-up box');
    await type(followUp, 'Send it to Kim instead.');
    // A message now would hide the only way to answer the paused run.
    expect(button(container, 'Send').disabled).toBe(true);

    await click(container, 'Approve');
    // The server would still run the approved call if a new message retired the card now.
    expect(button(container, 'Send').disabled).toBe(true);

    answer(
      jsonResponse(409, {
        error: { code: 'approval_already_decided', message: 'This approval was already decided.' },
      }),
    );
    await settle();
    expect(container.textContent).toContain('This request has already been decided.');
    expect(button(container, 'Send').disabled).toBe(false);
  });

  it('shows an accepted continuation as queued, and holds a follow-up until it ends', async () => {
    let stream: (response: Response) => void = () => undefined;
    continuation = () => new Promise<Response>((resolve) => (stream = resolve));
    const container = await open();
    const followUp = container.querySelector('textarea[aria-label="Ask a follow-up"]');
    if (!(followUp instanceof HTMLTextAreaElement)) throw new Error('no follow-up box');

    await click(container, 'Approve');
    await type(followUp, 'And copy Kim.');
    expect(container.querySelector('[role="group"]')).toBeNull();
    expect(container.textContent).toContain('Queued');
    expect(container.textContent).not.toContain('Awaiting approval');
    expect(button(container, 'Send').disabled).toBe(true);

    stream(eventStreamResponse(CONTINUATION_STREAM));
    await settle();
    expect(container.textContent).toContain('The mail has been sent.');
    expect(button(container, 'Send').disabled).toBe(false);
  });

  it('does not follow a decision that answers after the chat has gone', async () => {
    let answer: (response: Response) => void = () => undefined;
    decision = () => new Promise<Response>((resolve) => (answer = resolve));
    const container = await open();
    await click(container, 'Approve');

    act(() => lastRoot?.unmount());
    lastRoot = null;
    answer(
      jsonResponse(202, {
        run: fixtures.run({ id: CONTINUATION }),
        events: `/api/runs/${CONTINUATION}/events`,
      }),
    );
    await settle();
    expect(container.textContent).toBe('');
    expect(sent.some((each) => each.url.endsWith(`/api/runs/${CONTINUATION}/events`))).toBe(false);
  });
});
