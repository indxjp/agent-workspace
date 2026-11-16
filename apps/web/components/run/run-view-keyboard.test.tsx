// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MOCKUP_RUN_COMPLETED } from './mockup-fixture';
import { RunView } from './run-view';

async function followUpBox(
  onFollowUp: (text: string, attachments: readonly string[]) => void,
): Promise<HTMLTextAreaElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', () => new Promise(() => undefined));
  const container = document.createElement('div');
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <RunView run={MOCKUP_RUN_COMPLETED} sessionId="s1" onFollowUp={onFollowUp} />,
    );
    await Promise.resolve();
  });
  const box = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Ask a follow-up"]',
  );
  if (box === null) throw new Error('no follow-up box');
  await act(async () => {
    Reflect.set(HTMLTextAreaElement.prototype, 'value', 'つづけて', box);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
  return box;
}

async function press(target: Element, init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
    await Promise.resolve();
  });
}

// UX-23 in #2086: the follow-up box sent the Enter that confirms a Japanese conversion.
describe('RunView follow-up keyboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('does not send while Japanese input is being composed, then sends on a plain Enter', async () => {
    const onFollowUp = vi.fn<(text: string, attachments: readonly string[]) => void>();
    const box = await followUpBox(onFollowUp);
    await press(box, { key: 'Enter', keyCode: 13, isComposing: true });
    await press(box, { key: 'Enter', keyCode: 229 });
    expect(onFollowUp).not.toHaveBeenCalled();
    await press(box, { key: 'Enter', keyCode: 13 });
    expect(onFollowUp).toHaveBeenCalledWith('つづけて', []);
  });
});
