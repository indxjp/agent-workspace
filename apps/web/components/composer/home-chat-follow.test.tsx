// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClient } from '@indx-workspace/sdk';
import { eventStreamResponse, fetchDouble } from '@indx-workspace/sdk/testing';

import { MOCKUP_RUN } from '../run/mockup-fixture';
import { followRunInto, HomeChat, type HomeChatProps } from './home-chat';

describe('followRunInto onEvent', () => {
  it('names the run each event came from, so a continuation run is told apart', async () => {
    const frame =
      'event: agent.approval.requested\nid: 1\ndata: ' +
      JSON.stringify({
        frame: 'agent.approval.requested',
        engine: 'claude-agent-sdk',
        raw: null,
        toolCallId: 't1',
        toolName: 'mcp__aw-control__trial_run',
        canonicalCall: '{}',
      }) +
      '\n\n';
    const double = fetchDouble(() => eventStreamResponse(`${frame}event: done\ndata: {}\n\n`));
    const client = createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      fetch: double.fetch,
    });
    const seen: (string | undefined)[] = [];
    await new Promise<void>((resolve) => {
      followRunInto(
        'run-2',
        { initials: 'A', name: 'alex@example.com' },
        (update) => void update,
        client,
        (_event, runId) => {
          seen.push(runId);
          resolve();
        },
      );
    });
    expect(seen).toEqual(['run-2']);
  });
});

const PROPS: HomeChatProps = {
  agents: {
    kind: 'agents',
    agents: [
      {
        id: 'b',
        name: 'Builder',
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

describe('HomeChat follow', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('follows a run once per nonce, not on mount and not again for the same nonce', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetch);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const requestsFor = (runId: string) =>
      fetch.mock.calls.filter(([input]) =>
        (input instanceof Request ? input.url : input.toString()).includes(runId),
      ).length;

    const render = async (follow: NonNullable<HomeChatProps['follow']>) => {
      await act(async () => {
        root.render(<HomeChat {...PROPS} follow={follow} />);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };

    await render({ runId: 'run-1', nonce: 0 });
    expect(requestsFor('run-1')).toBe(0);

    await render({ runId: 'run-2', nonce: 1 });
    expect(requestsFor('run-2')).toBe(1);

    await render({ runId: 'run-2', nonce: 1 });
    expect(requestsFor('run-2')).toBe(1);
  });

  it('shows the approval slot under the transcript of a run, and only when one is given', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', () => new Promise(() => undefined));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const render = async (approval: HomeChatProps['approval']) => {
      await act(async () => {
        root.render(<HomeChat {...PROPS} run={MOCKUP_RUN} approval={approval} />);
        await Promise.resolve();
      });
    };

    await render(null);
    expect(container.textContent).not.toContain('Card goes here');

    await render(<p>Card goes here</p>);
    expect(container.textContent).toContain('Card goes here');
  });
});
