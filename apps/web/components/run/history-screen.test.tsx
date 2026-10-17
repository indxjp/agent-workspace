import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * `RunsHistoryScreen` reads `useSearchParams`/`usePathname`/`useRouter` from `next/navigation`,
 * which return `null`/throw outside a real Next.js router — there is no app router mounted under
 * plain `react-dom/server`, and this project has no jsdom/testing-library dependency to stand one
 * up (adding one would touch `package.json`/`pnpm-lock.yaml`, outside this task's `Owns` globs).
 * Mocking the module is the standard way to unit-test a component that only *reads* these hooks,
 * and it is what lets this file assert the same "first paint, before any fetch resolves" property
 * `projects-screen.test.tsx` already asserts for the Projects screen.
 */
let searchParams = new URLSearchParams('');

vi.mock('next/navigation', () => ({
  usePathname: () => '/runs',
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));

const { RunsHistoryScreen } = await import('./history-screen');

describe('RunsHistoryScreen', () => {
  it('renders the list view, filters and a loading state, before any fetch resolves', () => {
    searchParams = new URLSearchParams('');
    const html = renderToStaticMarkup(<RunsHistoryScreen />);
    expect(html).toContain('Runs');
    expect(html).toContain('Loading runs');
    expect(html).toContain('Status');
    expect(html).toContain('Search this page');
    expect(html).toContain('Agent');
    expect(html).toContain('Project');
    // The user filter is never shown until a real 200 has confirmed the server accepts it — see
    // `./history.ts`'s header. `useSearchParams`/`useState` alone cannot have confirmed that yet.
    expect(html).not.toContain('Started by</span>');
  });

  it('renders the detail panel instead of the list when ?run= is present', () => {
    searchParams = new URLSearchParams('run=a1111111-1111-4111-8111-111111111111');
    const html = renderToStaticMarkup(<RunsHistoryScreen />);
    expect(html).toContain('Back to Runs');
    expect(html).toContain('Loading run');
    expect(html).not.toContain('Loading runs');
  });

  it('keeps the route padding responsive at a mobile viewport', () => {
    searchParams = new URLSearchParams('');
    const html = renderToStaticMarkup(<RunsHistoryScreen />);
    expect(html).toContain('px-4');
    expect(html).toContain('sm:px-8');
  });
});
