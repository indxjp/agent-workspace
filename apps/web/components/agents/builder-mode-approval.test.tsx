// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '@indx-workspace/sdk/events';

import type { HomeChat } from '../composer/home-chat';
import { BuilderChat } from './builder-mode';
import { definitionBody } from './definition-fixture';

type HomeChatProps = ComponentProps<typeof HomeChat>;

const homeChat = vi.hoisted(() => ({ props: undefined as HomeChatProps | undefined }));
const client = vi.hoisted(() => ({
  approve: vi.fn(),
  reject: vi.fn(),
  list: vi.fn(),
}));

// The real HomeChat shows `approval` only inside a started run; this test is about BuilderChat's wiring.
vi.mock('../composer/home-chat', () => ({
  HomeChat: (props: HomeChatProps) => {
    homeChat.props = props;
    return props.approval;
  },
}));
vi.mock('../../lib/browser-client', () => ({
  browserClient: () => ({
    me: () => Promise.resolve(null),
    projects: { list: () => new Promise(() => undefined) },
    agents: { versions: { list: client.list } },
    runs: { approve: client.approve, reject: client.reject },
  }),
}));

const AGENT_ID = '0b7f4f0e-6a38-4d6c-9d0e-0c7a1f5a8c11';
const BUILDER = { id: 'b1', name: 'Builder' };
const USER = { initials: 'A', name: 'Alex' };

const asksForTrial: AgentEvent = {
  frame: 'agent.approval.requested',
  engine: 'claude-agent-sdk',
  raw: null,
  toolCallId: 'call-1',
  toolName: 'mcp__aw-control__trial_run',
  canonicalCall: JSON.stringify({ input: { agentId: AGENT_ID, version: 1, input: 'Refund' } }),
};

let container: HTMLDivElement;

async function pause(): Promise<void> {
  await act(async () => {
    createRoot(container).render(<BuilderChat builder={BUILDER} user={USER} />);
    await Promise.resolve();
  });
  await act(async () => {
    homeChat.props?.onAgentEvent?.(asksForTrial, 'run-1');
    await Promise.resolve();
  });
}

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((item) => item.textContent === label);

describe('BuilderChat approval', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', () => new Promise(() => undefined));
    container = document.createElement('div');
    document.body.append(container);
    client.list.mockResolvedValue({ items: [{ number: 1, body: definitionBody() }] });
    client.approve.mockResolvedValue({ run: { id: 'run-2' }, events: [] });
    client.reject.mockResolvedValue({ run: { id: 'run-3' }, events: [] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    for (const fn of Object.values(client)) fn.mockReset();
  });

  it('approves once, follows the continuation run and retires the card', async () => {
    await pause();
    expect(container.textContent).toContain('at most a $0.30 budget');
    await act(async () => {
      button('Approve')?.click();
      await Promise.resolve();
    });
    expect(client.approve).toHaveBeenCalledExactlyOnceWith('run-1');
    expect(client.reject).not.toHaveBeenCalled();
    expect(homeChat.props?.follow).toEqual({ runId: 'run-2', nonce: 1 });
    expect(container.textContent).not.toContain('at most a $0.30 budget');
  });

  it('rejects through the same path', async () => {
    await pause();
    await act(async () => {
      button('Reject')?.click();
      await Promise.resolve();
    });
    expect(client.reject).toHaveBeenCalledExactlyOnceWith('run-1');
    expect(client.approve).not.toHaveBeenCalled();
    expect(homeChat.props?.follow).toEqual({ runId: 'run-3', nonce: 1 });
  });

  it('keeps the card and shows a code when the server refuses the decision', async () => {
    client.approve.mockRejectedValue(new Error('offline'));
    await pause();
    await act(async () => {
      button('Approve')?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('request_failed');
    expect(homeChat.props?.follow).toBeUndefined();
  });

  describe('after a save', () => {
    const saveCall: AgentEvent = {
      frame: 'agent.tool.call',
      engine: 'claude-agent-sdk',
      raw: null,
      toolCallId: 'save-1',
      name: 'mcp__aw-control__draft_save',
      kind: 'mcp',
      input: { body: definitionBody() },
    };
    const savedResult = (output: unknown): AgentEvent => ({
      frame: 'agent.tool.result',
      engine: 'claude-agent-sdk',
      raw: null,
      toolCallId: 'save-1',
      status: 'completed',
      output: JSON.stringify(output),
      isError: false,
    });
    const SAVED = {
      ok: true,
      agentId: AGENT_ID,
      version: 2,
      pointer: 'local',
      awCommand: 'aw agents push',
    };

    const asksToSave: AgentEvent = {
      frame: 'agent.approval.requested',
      engine: 'claude-agent-sdk',
      raw: null,
      toolCallId: 'save-1',
      toolName: 'mcp__aw-control__draft_save',
      canonicalCall: JSON.stringify({ input: { body: definitionBody() } }),
    };

    /** Pauses on the save under run-1, decides, and emits the save under the continuation. */
    async function emitSave(output: unknown, decision = 'Approve'): Promise<void> {
      await act(async () => {
        createRoot(container).render(<BuilderChat builder={BUILDER} user={USER} />);
        await Promise.resolve();
      });
      await act(async () => {
        homeChat.props?.onAgentEvent?.(asksToSave, 'run-1');
        await Promise.resolve();
      });
      await act(async () => {
        button(decision)?.click();
        await Promise.resolve();
      });
      const continuation = homeChat.props?.follow?.runId;
      expect(continuation).toBe(decision === 'Approve' ? 'run-2' : 'run-3');
      await act(async () => {
        homeChat.props?.onAgentEvent?.(saveCall, continuation);
        homeChat.props?.onAgentEvent?.(savedResult(output), continuation);
        await Promise.resolve();
      });
    }

    const link = (label: string) =>
      [...container.querySelectorAll('a')].find((item) => item.textContent === label);
    const urlOf = (label: string) => new URL(link(label)?.getAttribute('href') ?? '', 'http://x');

    it('[US-BLD-05][unit][web] says "Saved as version 2 on local" and Try it links to a session pinned to version 2', async () => {
      await emitSave(SAVED);
      expect(container.textContent).toContain('Saved as version 2 on local');
      const tryIt = urlOf('Try it');
      expect(tryIt.pathname).toBe('/');
      expect(Object.fromEntries(tryIt.searchParams)).toEqual({ agent: AGENT_ID, version: '2' });
    });

    it('[US-BLD-05][unit][web] links View history and Promote to the agent versions tab', async () => {
      await emitSave(SAVED);
      const history = urlOf('View history');
      expect(history.pathname).toBe(`/agents/${AGENT_ID}`);
      expect(history.searchParams.get('tab')).toBe('versions');
      const promote = urlOf('Promote');
      expect(promote.pathname).toBe(`/agents/${AGENT_ID}`);
      expect(promote.searchParams.get('tab')).toBe('versions');
      expect(promote.hash).toBe('#versions-release-heading');
    });

    it('[US-BLD-05][unit][web] shows no header for a save in a rejected continuation', async () => {
      await emitSave(SAVED, 'Reject');
      expect(client.approve).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain('Saved as version');
      expect(link('Try it')).toBeUndefined();
    });

    it.each([
      ['a version that is not a positive integer', { ...SAVED, version: 0 }],
      ['an agent id that is not a uuid', { ...SAVED, agentId: '../agents' }],
      ['a pointer other than local', { ...SAVED, pointer: 'production' }],
      ['an unknown key', { ...SAVED, extra: true }],
    ])(
      '[US-BLD-05][unit][web] shows no header for a save result with %s',
      async (_name, output) => {
        await emitSave(output);
        expect(container.textContent).not.toContain('Saved as version');
        expect(link('Try it')).toBeUndefined();
      },
    );
  });
});
