// @vitest-environment happy-dom
import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

let searchParams = new URLSearchParams('');
const replace = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: vi.fn(), replace }),
}));

const { NewAgentScreen, nextAgentMode, parseAgentMode } = await import('./agent-form');

const { BuilderMode } = await import('./builder-mode');
const { NewAgentRoute } = await import('./builder-mode-route');

function render(query: string, chatEnabled: boolean): string {
  searchParams = new URLSearchParams(query);
  return renderToStaticMarkup(
    <NewAgentScreen
      chatEnabled={chatEnabled}
      chat={(modeSwitch) => <BuilderMode modeSwitch={modeSwitch} />}
    />,
  );
}

describe('NewAgentScreen mode switch', () => {
  it('has no Chat option before the caller’s features are known', () => {
    searchParams = new URLSearchParams('mode=chat');
    const html = renderToStaticMarkup(<NewAgentRoute />);
    expect(html).not.toContain('radiogroup');
    expect(html).toContain('Create Agent');
  });

  it('shows the form with Form selected when the feature is on', () => {
    const html = render('', true);
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/id="agent-mode-form"[^>]*aria-checked="true"[^>]*tabindex="0"/u);
    expect(html).toMatch(/id="agent-mode-chat"[^>]*aria-checked="false"[^>]*tabindex="-1"/u);
    expect(html).toContain('Create Agent');
  });

  it('selects Chat from ?mode=chat and replaces the form', () => {
    const html = render('mode=chat', true);
    expect(html).toMatch(/id="agent-mode-chat"[^>]*aria-checked="true"[^>]*tabindex="0"/u);
    expect(html).not.toContain('Create Agent');
    expect(html).toContain('Loading the Builder…');
  });

  it('falls back to the form for ?mode=chat when chat is not enabled', () => {
    const html = render('mode=chat', false);
    expect(html).toContain('Create Agent');
    expect(html).not.toContain('radiogroup');
    expect(html).not.toContain('Builder');
  });

  it('writes the chosen mode back to the URL', () => {
    // The catalogs never load, so the screen makes no request and the test sees only the switch.
    vi.stubGlobal('fetch', () => new Promise(() => undefined));
    searchParams = new URLSearchParams('');
    const container = document.createElement('div');
    document.body.append(container);
    flushSync(() => {
      createRoot(container).render(<NewAgentScreen chatEnabled />);
    });
    const chat = container.querySelector<HTMLButtonElement>('#agent-mode-chat');
    chat?.click();
    expect(replace).toHaveBeenLastCalledWith('/agents/new?mode=chat');
    chat?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(replace).toHaveBeenLastCalledWith('/agents/new');
    expect(replace).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  describe('reading /api/me', () => {
    const me = (features: readonly string[]) => ({
      principalId: 'principal-1',
      kind: 'membership',
      role: 'builder',
      workspaceId: 'ws-1',
      userId: 'user-1',
      label: 'Ada',
      features,
    });
    async function chatOption(features: readonly string[]): Promise<boolean> {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.stubGlobal('fetch', (input: string | URL) =>
        String(input).endsWith('/api/me')
          ? Promise.resolve(Response.json(me(features)))
          : new Promise<Response>(() => undefined),
      );
      searchParams = new URLSearchParams('');
      const container = document.createElement('div');
      document.body.append(container);
      await act(() => {
        createRoot(container).render(<NewAgentRoute />);
        return Promise.resolve();
      });
      return container.querySelector('#agent-mode-chat') !== null;
    }
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('shows the Chat tab when the caller’s features include builder', async () => {
      await expect(chatOption(['chat', 'builder'])).resolves.toBe(true);
    });

    it('hides the Chat tab when they do not', async () => {
      await expect(chatOption(['chat'])).resolves.toBe(false);
    });
  });

  it('parses only mode=chat with the feature on', () => {
    expect(parseAgentMode('chat', true)).toBe('chat');
    expect(parseAgentMode('chat', false)).toBe('form');
    expect(parseAgentMode('nonsense', true)).toBe('form');
    expect(parseAgentMode(null, true)).toBe('form');
  });

  it.each([
    ['form', 'ArrowRight', 'chat'],
    ['form', 'ArrowDown', 'chat'],
    ['chat', 'ArrowRight', 'form'],
    ['chat', 'ArrowLeft', 'form'],
    ['form', 'ArrowLeft', 'chat'],
    ['chat', 'ArrowUp', 'form'],
    ['chat', 'Home', 'form'],
    ['form', 'End', 'chat'],
    ['form', 'Tab', null],
    ['chat', 'Enter', null],
  ] as const)('moves from %s on %s to %s', (current, key, expected) => {
    expect(nextAgentMode(current, key)).toBe(expected);
  });
});
