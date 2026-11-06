// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HomeChat, type HomeChatProps } from './home-chat';
import type { ComposerAgent } from './model';

const AGENT: ComposerAgent = {
  id: 'a',
  name: 'Research',
  detail: '',
  files: [],
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

async function render(props: HomeChatProps = PROPS): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', () => new Promise(() => undefined));
  const container = document.createElement('div');
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(<HomeChat {...props} />);
    await Promise.resolve();
  });
  return container;
}

function composer(container: HTMLElement): HTMLTextAreaElement | null {
  return container.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');
}

async function type(container: HTMLElement, text: string): Promise<void> {
  const box = composer(container);
  if (box === null) throw new Error('no composer');
  await act(async () => {
    // The prototype setter, so React's value tracker sees a change and fires onChange.
    Reflect.set(HTMLTextAreaElement.prototype, 'value', text, box);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

async function press(target: Element, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

// UX-23 in #2086: Enter did nothing in the home chat; only the Send button sent.
describe('HomeChat composer keyboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('sends on Enter', async () => {
    const container = await render();
    await type(container, 'Summarise Q3');
    const box = composer(container);
    if (box === null) throw new Error('no composer');
    const event = await press(box, { key: 'Enter', keyCode: 13 });
    expect(event.defaultPrevented).toBe(true);
    expect(composer(container)).toBeNull();
    expect(container.textContent).toContain('Summarise Q3');
  });

  it('keeps Shift+Enter as a newline and does not send', async () => {
    const container = await render();
    await type(container, 'line one');
    const box = composer(container);
    if (box === null) throw new Error('no composer');
    const event = await press(box, { key: 'Enter', keyCode: 13, shiftKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(composer(container)).not.toBeNull();
  });

  it('does not send the Enter that confirms Japanese input', async () => {
    const container = await render();
    await type(container, 'にほんご');
    const box = composer(container);
    if (box === null) throw new Error('no composer');
    await press(box, { key: 'Enter', keyCode: 13, isComposing: true });
    await press(box, { key: 'Enter', keyCode: 229 });
    expect(composer(container)).not.toBeNull();
  });

  it('does not send on Enter while Send is disabled', async () => {
    const container = await render();
    await type(container, '   ');
    const box = composer(container);
    if (box === null) throw new Error('no composer');
    await press(box, { key: 'Enter', keyCode: 13 });
    expect(composer(container)).not.toBeNull();

    document.body.replaceChildren();
    const signedOut = await render({ ...PROPS, user: null });
    await type(signedOut, 'hello');
    const signedOutBox = composer(signedOut);
    if (signedOutBox === null) throw new Error('no composer');
    await press(signedOutBox, { key: 'Enter', keyCode: 13 });
    expect(composer(signedOut)).not.toBeNull();
  });

  it('marks the box while the textarea has focus, since the textarea draws no outline', async () => {
    const container = await render();
    const box = container.querySelector('[data-testid="composer-box"]');
    expect(box?.className).toContain('has-[textarea:focus-visible]:border-accent');
    expect(composer(container)?.className).toContain('focus:outline-none');
  });

  it('closes an open picker on Esc and returns focus to its toggle', async () => {
    const container = await render();
    const files = container.querySelector<HTMLElement>('details[data-picker="files"]');
    const summary = files?.querySelector<HTMLElement>('summary');
    if (files === null || files === undefined || summary === null || summary === undefined) {
      throw new Error('no files picker');
    }
    await act(async () => {
      summary.click();
      await Promise.resolve();
    });
    expect(files.hasAttribute('open')).toBe(true);
    const link = files.querySelector('a');
    if (link === null) throw new Error('no link inside the panel');
    await press(link, { key: 'Escape' });
    expect(files.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(summary);
  });
});

// UX-23: "Skip to content" lands on the page's <main>. The home page is that landmark itself, on
// its start screen and once the run view replaces it; embedded, the chat draws none (the Builder).
describe('HomeChat landmark', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  async function sendFirstMessage(container: HTMLElement): Promise<void> {
    await type(container, 'Summarise Q3');
    const box = composer(container);
    if (box === null) throw new Error('no composer');
    await press(box, { key: 'Enter', keyCode: 13 });
    expect(composer(container)).toBeNull();
  }

  it('is the one main, with the one h1, on the home page start and run screens', async () => {
    const container = await render();
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('main h1')?.textContent).toContain('What can I help with?');

    await sendFirstMessage(container);
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('main h1')?.textContent).toBe('Research');
  });

  it('draws no main and no h1 when another screen holds it', async () => {
    const container = await render({ ...PROPS, landmark: false });
    expect(container.querySelector('main')).toBeNull();
    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('h2')?.textContent).toContain('What can I help with?');

    await sendFirstMessage(container);
    expect(container.querySelector('main')).toBeNull();
    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('h2')?.textContent).toBe('Research');
  });
});
