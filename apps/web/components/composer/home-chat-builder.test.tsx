// @vitest-environment happy-dom
/**
 * The optional props `HomeChat` takes for the Builder chat: a locked agent, a composer prefill and
 * a tap on each parsed agent event. Without them the component is the home page; that is the other
 * test files' job.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient } from '@indx-workspace/sdk';
import type { AgentEvent } from '@indx-workspace/sdk/events';
import {
  eventStreamResponse,
  fetchDouble,
  fixtures,
  jsonResponse,
} from '@indx-workspace/sdk/testing';

import { followRunInto, HomeChat, type HomeChatProps } from './home-chat';
import type { ComposerAgent } from './model';

const USER = { initials: 'A', name: 'alex@example.com' };

function agent(id: string, name: string): ComposerAgent {
  return {
    id,
    name,
    detail: '',
    files: [],
    connectors: [],
    sandbox: 'Standard Sandbox',
    runTarget: { kind: 'runnable', source: 'workspace', connectionName: 'c', model: 'm' },
    drivableProviders: ['anthropic'],
  };
}

function props(overrides: Partial<HomeChatProps>): HomeChatProps {
  return {
    agents: { kind: 'agents', agents: [agent('a', 'Alpha'), agent('b', 'Builder')] },
    recent: [],
    user: USER,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', () => new Promise(() => undefined));
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('HomeChat with a locked agent', () => {
  it('offers no agent picker and names the locked agent as the run target', () => {
    const html = renderToStaticMarkup(
      <HomeChat {...props({ agent: { id: 'b', locked: true } })} />,
    );
    expect(html).not.toContain('data-testid="composer-agent-picker"');
    expect(html).toMatch(/data-testid="composer-run-target"[^>]*data-agent-id="b"/u);
  });

  it('keeps the agent picker when nothing is locked', () => {
    expect(renderToStaticMarkup(<HomeChat {...props({})} />)).toContain(
      'data-testid="composer-agent-picker"',
    );
  });

  it('runs as nobody, and disables Send, when the locked agent is not in the list', () => {
    const html = renderToStaticMarkup(
      <HomeChat {...props({ agent: { id: 'missing', locked: true } })} />,
    );
    expect(html).not.toContain('data-agent-id="a"');
    expect(html).not.toContain('data-agent-id="b"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*Send/u);
  });
});

describe('HomeChat prefill', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  it('puts the text in the composer and focuses it when the nonce changes, not on mount', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const textarea = () => container.querySelector('textarea');

    act(() => {
      root.render(<HomeChat {...props({ prefill: { text: 'Old: ', nonce: 1 } })} />);
    });
    expect(textarea()?.value).toBe('');

    act(() => {
      root.render(<HomeChat {...props({ prefill: { text: 'Change Permissions: ', nonce: 2 } })} />);
    });
    expect(textarea()?.value).toBe('Change Permissions: ');
    expect(document.activeElement).toBe(textarea());
  });
});

describe('HomeChat pinned to a version', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  it('[US-BLD-05][unit][web] sends the version with the first run only', async () => {
    const started: unknown[] = [];
    vi.stubGlobal('fetch', (input: Request | string | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://x');
      if (url.pathname === '/api/agents/b/runs') {
        started.push(JSON.parse(typeof init?.body === 'string' ? init.body : 'null'));
        return Promise.resolve(
          jsonResponse(202, {
            run: fixtures.run({ sessionId: '77777777-7777-4777-8777-777777777777' }),
            events: '/api/runs/r1/events',
          }),
        );
      }
      return Promise.resolve(
        url.pathname.endsWith('/events')
          ? eventStreamResponse(
              'event: run.status\nid: 1\ndata: {"status":"completed","error":null}\n\nevent: done\ndata: {}\n\n',
            )
          : jsonResponse(200, []),
      );
    });
    const container = document.createElement('div');
    document.body.append(container);
    await act(async () => {
      createRoot(container).render(
        <HomeChat {...props({ agent: { id: 'b', locked: true }, version: 2 })} />,
      );
      await Promise.resolve();
    });
    const send = async (text: string) => {
      const textarea = container.querySelector('textarea');
      await act(async () => {
        if (textarea === null) throw new Error('no composer');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
          textarea,
          text,
        );
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        await Promise.resolve();
      });
      await act(async () => {
        [...container.querySelectorAll('button')]
          .find((button) => button.textContent?.trim() === 'Send')
          ?.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    };
    await send('first');
    await send('second');
    expect(started).toMatchObject([{ prompt: 'first', version: 2 }, { prompt: 'second' }]);
    expect(started[1]).not.toHaveProperty('version');
  });
});

describe('followRunInto onEvent', () => {
  it('hands each parsed agent event to the caller', async () => {
    const input = { body: { definition: 'x' } };
    const frame =
      'event: agent.tool.call\nid: 1\ndata: ' +
      JSON.stringify({
        frame: 'agent.tool.call',
        engine: 'claude-agent-sdk',
        raw: null,
        toolCallId: 't1',
        name: 'mcp__aw-control__draft_check',
        kind: 'mcp',
        input,
      }) +
      '\n\n';
    const double = fetchDouble(() => eventStreamResponse(`${frame}event: done\ndata: {}\n\n`));
    const client = createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      fetch: double.fetch,
    });
    const seen: AgentEvent[] = [];
    await new Promise<void>((resolve) => {
      followRunInto(
        'r1',
        USER,
        (update) => void update,
        client,
        (event) => {
          seen.push(event);
          resolve();
        },
      );
    });
    expect(seen).toMatchObject([
      { frame: 'agent.tool.call', name: 'mcp__aw-control__draft_check', input },
    ]);
  });
});
