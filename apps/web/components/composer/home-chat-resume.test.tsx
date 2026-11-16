// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HomeChat, type HomeChatProps } from './home-chat';

const started = vi.hoisted(() => ({
  calls: [] as {
    readonly sessionId: string | null;
    readonly prompt: string;
    readonly onStarted: (sessionId: string, runId: string) => void;
  }[],
}));
vi.mock('./home-chat-live', async (importActual) => {
  const actual = await importActual<typeof import('./home-chat-live')>();
  return {
    ...actual,
    runAgentAndFollow: (args: (typeof started.calls)[number]) => {
      started.calls.push(args);
    },
  };
});

const SESSION = '33333333-3333-4333-8333-333333333333';

const PROPS: HomeChatProps = {
  agents: {
    kind: 'agents',
    agents: [
      {
        id: 'b',
        name: 'Report writer',
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
  agent: { id: 'b', locked: true },
};

const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => undefined));

/** The `PATCH /api/sessions/:id` bodies the screen sent. */
async function titleUpdates(): Promise<readonly unknown[]> {
  const bodies: unknown[] = [];
  for (const [input, init] of fetch.mock.calls) {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === 'PATCH' && request.url.includes('/api/sessions/')) {
      const body: unknown = await request.json();
      bodies.push({ url: new URL(request.url).pathname, body });
    }
  }
  return bodies;
}

async function sendFrom(props: HomeChatProps, text: string) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<HomeChat {...props} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');
  if (input === null) throw new Error('no composer');
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    descriptor?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

// UX-05 in #2086: a chat opened from the sidebar's recent chats continues that session.
describe('HomeChat continuing an earlier chat', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', fetch);
    fetch.mockClear();
    started.calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('says it is continuing, and sends the first message into that session', async () => {
    const container = await sendFrom(
      {
        ...PROPS,
        resume: { kind: 'continue', sessionId: SESSION, notice: 'Continuing “Q3 refunds”.' },
      },
      'And the CSV too',
    );
    expect(started.calls.map((call) => call.sessionId)).toEqual([SESSION]);
    expect(container.textContent).not.toContain('Continuing');
    // A continued chat keeps its title: nothing renames it.
    await act(async () => {
      started.calls[0]?.onStarted(SESSION, 'run-2');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(await titleUpdates()).toEqual([]);
  });

  it('shows the notice before anything is sent, as a status, and a refusal as an alert', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <HomeChat
          {...PROPS}
          resume={{ kind: 'continue', sessionId: SESSION, notice: 'Continuing “Q3 refunds”.' }}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Continuing “Q3 refunds”.',
    );
    await act(async () => {
      root.render(<HomeChat {...PROPS} resume={{ kind: 'refused', notice: 'Cannot continue.' }} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Cannot continue.');
  });

  // UX-05 step 2: the earlier messages are shown above the composer, and stay once a message is sent.
  const HISTORY = {
    heading: 'Earlier in this chat',
    earlierNote: '2 older messages are not shown.',
    turns: [
      { speaker: 'user' as const, paragraphs: ['Summarise the Q3 refunds'] },
      {
        speaker: 'agent' as const,
        paragraphs: ['Refunds rose 12%.', 'Most were late deliveries.'],
      },
    ],
  };

  it('shows the earlier messages, named, above the composer of a continued chat', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <HomeChat
          {...PROPS}
          resume={{ kind: 'continue', sessionId: SESSION, notice: 'Continuing.', history: HISTORY }}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const list = container.querySelector('[data-testid="resumed-history"]');
    expect(list?.querySelector('h2')?.textContent).toBe('Earlier in this chat');
    expect(list?.textContent).toContain('2 older messages are not shown.');
    const items = [...(list?.querySelectorAll('li') ?? [])].map((item) =>
      [...item.children].map((child) => child.textContent),
    );
    expect(items).toEqual([
      ['alex@example.com', 'Summarise the Q3 refunds'],
      ['Report writer', 'Refunds rose 12%.', 'Most were late deliveries.'],
    ]);
    // The history comes before the composer, so the page reads top to bottom.
    const composer = container.querySelector('[data-testid="composer-box"]');
    expect(
      list !== null && composer !== null && list.compareDocumentPosition(composer) & 4,
    ).toBeTruthy();
  });

  it('keeps the earlier messages above the first new one once it is sent', async () => {
    const container = await sendFrom(
      {
        ...PROPS,
        resume: { kind: 'continue', sessionId: SESSION, notice: 'Continuing.', history: HISTORY },
      },
      'Which month was worst?',
    );
    const text = container.textContent;
    const order = [
      'Summarise the Q3 refunds',
      'Most were late deliveries.',
      'Which month was worst?',
    ];
    const positions = order.map((part) => text.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(started.calls.map((call) => call.prompt)).toEqual(['Which month was worst?']);
  });

  it('draws nothing for a history with no messages', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const empty = { ...HISTORY, turns: [] };
    await act(async () => {
      root.render(
        <HomeChat
          {...PROPS}
          resume={{ kind: 'continue', sessionId: SESSION, notice: 'Continuing.', history: empty }}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="resumed-history"]')).toBeNull();
  });

  it('shows no earlier messages for a new chat', async () => {
    const container = await sendFrom(PROPS, 'Hello');
    expect(container.querySelector('[data-testid="resumed-history"]')).toBeNull();
    expect(container.textContent).not.toContain('Earlier in this chat');
  });

  it('starts a new session for a new chat, and titles it from the first message', async () => {
    await sendFrom(PROPS, '  Write the Q3\nrefunds report ');
    expect(started.calls.map((call) => call.sessionId)).toEqual([null]);
    await act(async () => {
      started.calls[0]?.onStarted(SESSION, 'run-1');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(await titleUpdates()).toEqual([
      { url: `/api/sessions/${SESSION}`, body: { title: 'Write the Q3 refunds report' } },
    ]);
  });
});
