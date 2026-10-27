// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '@indx-workspace/sdk/events';

import type { HomeChat } from '../composer/home-chat';
import { BuilderChat, BuilderMode, BuilderPreviewPanel } from './builder-mode';
import { definitionBody } from './definition-fixture';

type HomeChatProps = ComponentProps<typeof HomeChat>;

/** The props the real `HomeChat` last rendered with, so a test can drive its callbacks. */
const homeChat = vi.hoisted(() => ({ props: undefined as HomeChatProps | undefined }));

vi.mock('../composer/home-chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../composer/home-chat')>();
  return {
    ...actual,
    HomeChat: (props: HomeChatProps) => {
      homeChat.props = props;
      return <actual.HomeChat {...props} />;
    },
  };
});

vi.mock('./agent-requests-model', () => ({
  loadAgents: () => Promise.resolve({ ok: true, value: [] }),
}));
vi.mock('../../lib/request-outcome', () => ({
  requestOutcome: () => Promise.resolve({ ok: true, value: { label: 'Alex' } }),
}));
vi.mock('../../lib/browser-client', () => ({
  browserClient: () => ({
    me: () => Promise.resolve(null),
    projects: { list: () => new Promise(() => undefined) },
  }),
}));

const ENGINE = 'claude-agent-sdk';

function toolCall(toolCallId: string, name: string, input: unknown): AgentEvent {
  return {
    frame: 'agent.tool.call',
    engine: ENGINE,
    raw: null,
    toolCallId,
    name,
    kind: 'mcp',
    input,
  };
}

function toolResult(toolCallId: string, output: unknown): AgentEvent {
  return {
    frame: 'agent.tool.result',
    engine: ENGINE,
    raw: null,
    toolCallId,
    status: 'completed',
    output: JSON.stringify(output),
    isError: false,
  };
}

function say(text: string): AgentEvent {
  return {
    frame: 'agent.message',
    engine: ENGINE,
    raw: null,
    messageId: 'm1',
    role: 'assistant',
    blocks: [{ type: 'text', text }],
  };
}

const WRITES = definitionBody({
  agent: {
    permissions: {
      readFiles: true,
      writeFiles: true,
      runCommands: false,
      unrestrictedNetwork: false,
    },
  },
});

describe('BuilderPreviewPanel', () => {
  it('shows the latest tool input, not what the assistant says, and the failed check code and details', () => {
    const html = renderToStaticMarkup(
      <BuilderPreviewPanel
        events={[
          say('Write files is off for this agent.'),
          toolCall('1', 'mcp__aw-control__draft_check', { body: WRITES }),
          toolResult('1', {
            ok: false,
            code: 'agent_definition_references_missing',
            message: 'missing',
            details: ['connector:erp'],
          }),
        ]}
        onAskBuilder={() => undefined}
      />,
    );
    expect(html).toMatch(/Write files<\/dt><dd[^>]*>Allowed/u);
    expect(html).toContain('role="alert"');
    expect(html).toContain('agent_definition_references_missing');
    expect(html).toContain('connector:erp');
    expect(html).not.toContain('<textarea');
  });

  it('says nothing is there yet before the first draft', () => {
    const html = renderToStaticMarkup(
      <BuilderPreviewPanel events={[]} onAskBuilder={() => undefined} />,
    );
    expect(html).toContain('The definition appears here once the Builder checks a draft.');
  });
});

const BUILDER = { id: 'b1', name: 'Builder' };
const USER = { initials: 'A', name: 'Alex' };

describe('BuilderChat layout', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', () => new Promise(() => undefined));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('is one column below lg, with the definition behind a disclosure and before the chat', () => {
    const html = renderToStaticMarkup(<BuilderChat builder={BUILDER} user={USER} />);
    expect(html).toContain('grid-cols-1');
    expect(html).toContain('lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]');
    expect(html).toContain('min-w-0');
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*lg:hidden[^>]*>Definition</u);
    expect(html).toMatch(/id="builder-definition"[^>]*class="hidden[^"]*lg:block"/u);
    expect(html.indexOf('builder-definition')).toBeLessThan(html.indexOf('<textarea'));
    expect(html).not.toContain('data-testid="composer-agent-picker"');
  });

  it('opens the definition when the disclosure is pressed', () => {
    const container = document.createElement('div');
    document.body.append(container);
    act(() => {
      createRoot(container).render(<BuilderChat builder={BUILDER} user={USER} />);
    });
    const button = container.querySelector('button[aria-controls="builder-definition"]');
    const panel = container.querySelector('#builder-definition');
    expect(panel?.className).toMatch(/\bhidden\b/u);
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(panel?.className).toMatch(/\bblock\b/u);
    expect(panel?.className).not.toMatch(/\bhidden\b/u);
  });

  function renderChat(): HTMLElement {
    const container = document.createElement('div');
    document.body.append(container);
    act(() => {
      createRoot(container).render(<BuilderChat builder={BUILDER} user={USER} />);
    });
    return container;
  }

  function emit(...events: AgentEvent[]) {
    act(() => {
      for (const event of events) homeChat.props?.onAgentEvent?.(event);
    });
  }

  it('shows the refusal code when a Builder tool answers builder_disabled', () => {
    const container = renderChat();
    emit(
      toolCall('1', 'mcp__aw-control__catalog_list', {}),
      toolResult('1', { ok: false, code: 'builder_disabled', message: 'off' }),
    );
    const alert = container.querySelector('p[role="alert"]');
    expect(alert?.textContent).toContain('The Builder is not available in this workspace');
    expect(alert?.textContent).toContain('builder_disabled');
  });

  it('shows the refusal code when a Builder tool answers builder_model_unavailable', () => {
    const container = renderChat();
    emit(
      toolCall('1', 'mcp__aw-control__catalog_list', {}),
      toolResult('1', { ok: false, code: 'builder_model_unavailable', message: 'no model' }),
    );
    const alert = container.querySelector('p[role="alert"]');
    expect(alert?.textContent).toContain('builder_model_unavailable');
  });

  it('lists two equal check details without a duplicate-key warning', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const container = renderChat();
    emit(
      toolCall('1', 'mcp__aw-control__draft_check', { body: WRITES }),
      toolResult('1', {
        ok: false,
        code: 'agent_definition_references_missing',
        message: 'x',
        details: ['same', 'same'],
      }),
    );
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('prefills the composer with the section when Ask the Builder is pressed', () => {
    const container = renderChat();
    emit(toolCall('1', 'mcp__aw-control__draft_check', { body: WRITES }));
    const ask = container.querySelector(
      'button[aria-label="Ask the Builder to change Permissions"]',
    );
    act(() => {
      ask?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const first = homeChat.props?.prefill;
    expect(first?.text).toBe('Change Permissions: ');
    act(() => {
      ask?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(homeChat.props?.prefill?.text).toBe('Change Permissions: ');
    expect(homeChat.props?.prefill?.nonce).toBeGreaterThan(first?.nonce ?? Infinity);
  });
});

describe('BuilderMode', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('says the Builder is unavailable, and offers no chat, when no agent is the built-in Builder', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    await act(async () => {
      createRoot(container).render(<BuilderMode modeSwitch={null} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('The Builder is not available in this workspace');
    expect(container.querySelector('textarea')).toBeNull();
  });
});
