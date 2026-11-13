import { isValidElement, type ComponentProps, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { RunsHistoryScreen } from '../../../components/run/history-screen';
import RunsPage from './page';

const acceptLanguage = vi.hoisted((): { value: string | null } => ({ value: 'en' }));
vi.mock('next/headers', () => ({
  headers: () =>
    Promise.resolve(
      new Headers(acceptLanguage.value === null ? {} : { 'accept-language': acceptLanguage.value }),
    ),
}));
vi.mock('../feature-gate', () => ({ switchedOffPanel: () => Promise.resolve(null) }));

/** The screen inside the page's Suspense boundary, and the boundary's fallback. */
async function rendered(): Promise<{
  screen: ComponentProps<typeof RunsHistoryScreen>;
  fallback: ReactElement<{ lang: string }>;
}> {
  const page = await RunsPage();
  if (!isValidElement<{ children: unknown; fallback: unknown }>(page)) {
    throw new Error('RunsPage did not return its Suspense boundary');
  }
  const { children, fallback } = page.props;
  if (!isValidElement<ComponentProps<typeof RunsHistoryScreen>>(children)) {
    throw new Error('RunsPage did not render the Runs screen');
  }
  if (!isValidElement<{ lang: string }>(fallback)) throw new Error('no fallback');
  return { screen: children.props, fallback };
}

// UX-15 in #2086: the Runs screen speaks the reader's language, as the shell negotiates it.
describe('RunsPage and the reader’s language', () => {
  it('passes the negotiated locale to the screen and its loading fallback', async () => {
    acceptLanguage.value = 'ja-JP,ja;q=0.9,en;q=0.8';
    let page = await rendered();
    expect(page.screen.locale).toBe('ja');
    expect(page.fallback.props.lang).toBe('ja');
    acceptLanguage.value = 'en-US';
    page = await rendered();
    expect(page.screen.locale).toBe('en');
    acceptLanguage.value = null;
    expect((await rendered()).screen.locale).toBe('en');
  });
});
