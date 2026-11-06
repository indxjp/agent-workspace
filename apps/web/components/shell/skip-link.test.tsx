// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SkipLink } from './skip-link';

async function renderWith(page: string): Promise<HTMLAnchorElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(<SkipLink />);
    await Promise.resolve();
  });
  container.insertAdjacentHTML('beforeend', page);
  const link = container.querySelector('a');
  if (link === null) throw new Error('no skip link');
  return link;
}

// UX-23 in #2086: Tab started in the sidebar on every screen, with no way past it.
describe('SkipLink', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('moves focus to the page main landmark', async () => {
    const link = await renderWith('<nav><a href="/x">Agents</a></nav><main><h1>Files</h1></main>');
    expect(link.textContent).toBe('Skip to content');
    link.click();
    const main = document.querySelector('main');
    expect(document.activeElement).toBe(main);
    expect(main?.getAttribute('tabindex')).toBe('-1');
  });

  it('keeps a tabindex the page already gave its main', async () => {
    const link = await renderWith('<main tabindex="0"></main>');
    link.click();
    expect(document.querySelector('main')?.getAttribute('tabindex')).toBe('0');
  });

  it('is the first thing the shell draws, before the sidebar', () => {
    const layout = readFileSync(
      path.resolve(import.meta.dirname, '../../app/(shell)/layout.tsx'),
      'utf8',
    );
    const skip = layout.indexOf('<SkipLink />');
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(layout.indexOf('<Sidebar'));
  });
});
