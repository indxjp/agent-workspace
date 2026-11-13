import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { newAgentStrings } from './new-agent-messages';

// The New Agent screen hands its own reader's language to a refused create (UX-15 in #2086): the
// form is the real one, with only its refusal set.
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../../lib/browser-client', () => ({ browserClient: () => ({}) }));
vi.mock('./use-new-agent-form', async (original) => {
  const real = await original<typeof import('./use-new-agent-form')>();
  return {
    ...real,
    useNewAgentForm: (...args: Parameters<typeof real.useNewAgentForm>) => ({
      ...real.useNewAgentForm(...args),
      problem: { kind: 'api', status: 409, code: 'name_taken', message: 'Taken.' } as const,
    }),
  };
});

const { NewAgentScreen } = await import('./agent-form');

describe('the New Agent screen with a refused create', () => {
  it('leads the refusal in Japanese for a Japanese reader', () => {
    const html = renderToStaticMarkup(<NewAgentScreen chatEnabled={false} locale="ja" />);
    expect(html).toContain(newAgentStrings('ja').createFailed);
    expect(html).toContain('<div lang="en">Taken.</div>');
  });

  it('shows an English reader the refusal alone', () => {
    const html = renderToStaticMarkup(<NewAgentScreen chatEnabled={false} locale="en" />);
    expect(html).not.toContain(newAgentStrings('en').createFailed);
    expect(html).toContain('409 name_taken');
  });
});
