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

/** The `filesEnabled` the route last handed the Builder chat. */
const builderMode = vi.hoisted(() => ({ filesEnabled: undefined as boolean | undefined }));
vi.mock('./builder-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./builder-mode')>();
  return {
    ...actual,
    BuilderMode: (props: Parameters<typeof actual.BuilderMode>[0]) => {
      builderMode.filesEnabled = props.filesEnabled;
      return <actual.BuilderMode {...props} />;
    },
  };
});

const { NewAgentScreen, nextAgentMode, parseAgentMode } = await import('./agent-form');

const { BuilderMode } = await import('./builder-mode');
const { NewAgentRoute } = await import('./builder-mode-route');

function render(query: string, chatEnabled: boolean): string {
  searchParams = new URLSearchParams(query);
  return renderToStaticMarkup(
    <NewAgentScreen
      chatEnabled={chatEnabled}
      chat={(modeSwitch) => <BuilderMode modeSwitch={modeSwitch} filesEnabled />}
    />,
  );
}

describe('NewAgentScreen mode switch', () => {
  it('has no Chat option before the caller’s features are known', () => {
    searchParams = new URLSearchParams('mode=chat');
    const html = renderToStaticMarkup(<NewAgentRoute filesEnabled />);
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
    async function chatOption(
      features: readonly string[],
      query = '',
      filesEnabled = true,
    ): Promise<boolean> {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.stubGlobal('fetch', (input: string | URL) =>
        String(input).endsWith('/api/me')
          ? Promise.resolve(Response.json(me(features)))
          : new Promise<Response>(() => undefined),
      );
      searchParams = new URLSearchParams(query);
      const container = document.createElement('div');
      document.body.append(container);
      await act(() => {
        createRoot(container).render(<NewAgentRoute filesEnabled={filesEnabled} />);
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

    // UX-21 in #2086: the Files switch the server page read reaches the Builder chat.
    it.each([false, true])('hands filesEnabled=%s to the Builder chat', async (filesEnabled) => {
      builderMode.filesEnabled = undefined;
      await expect(chatOption(['chat', 'builder'], 'mode=chat', filesEnabled)).resolves.toBe(true);
      expect(builderMode.filesEnabled).toBe(filesEnabled);
    });
  });

  it('numbers its steps 1 to 5 in the order they appear (UX-22)', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    // Every read is refused, so each step renders its own empty state.
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        Response.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 }),
      ),
    );
    searchParams = new URLSearchParams('');
    const container = document.createElement('div');
    document.body.append(container);
    await act(async () => {
      createRoot(container).render(<NewAgentScreen chatEnabled={false} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const headings = [...container.querySelectorAll('form h2, form legend')]
      .map((node) => node.textContent)
      .filter((text) => text.startsWith('Step '));
    expect(headings).toEqual([
      'Step 1 · Name and instructions',
      'Step 2 · Model',
      'Step 3 · Runtime',
      'Step 4 · Resources',
      'Step 5 · Permissions',
    ]);
    vi.unstubAllGlobals();
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
