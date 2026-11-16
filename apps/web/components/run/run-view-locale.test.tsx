// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { withStatus } from '@indx-workspace/react/run-model';

import { MOCKUP_RUN_COMPLETED } from './mockup-fixture';
import { RunView } from './run-view';

async function render(languages: readonly string[]): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', () => new Promise(() => undefined));
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages);
  const container = document.createElement('div');
  document.body.append(container);
  const run = withStatus(MOCKUP_RUN_COMPLETED, {
    label: 'Awaiting approval',
    tone: 'warn',
    dot: false,
  });
  await act(async () => {
    createRoot(container).render(<RunView run={run} sessionId="s1" onFollowUp={() => undefined} />);
    await Promise.resolve();
  });
  return container;
}

// UX-15 in #2086: the run view's own words follow the reader's language.
describe('RunView locale', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('draws its badge, follow-up box, Send and technical details in Japanese for a ja reader', async () => {
    const view = await render(['ja-JP', 'ja']);
    expect(view.querySelector('textarea[aria-label="続けて質問する"]')).not.toBeNull();
    expect(view.textContent).toContain('承認待ち');
    expect(view.textContent).not.toContain('Awaiting approval');
    expect([...view.querySelectorAll('button')].map((b) => b.textContent)).toContain('送信');
    expect(view.querySelector('summary')?.textContent).toContain('技術的な詳細を表示');
    // A screen reader reads the translated parts as Japanese (`app/layout.tsx`).
    expect(view.querySelector('textarea')?.closest('[lang]')?.getAttribute('lang')).toBe('ja');
    expect(view.querySelector('details')?.getAttribute('lang')).toBe('ja');
  });

  it('keeps the English for an English reader', async () => {
    const view = await render(['en-US']);
    expect(view.querySelector('textarea[aria-label="Ask a follow-up"]')).not.toBeNull();
    expect(view.textContent).toContain('Awaiting approval');
    expect(view.querySelector('summary')?.textContent).toContain('Show technical details');
  });
});
