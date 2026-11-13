import { isValidElement, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { HomeChat } from '../../components/composer/home-chat';
import HomePage from './page';

const language = vi.hoisted(() => ({ value: 'ja-JP,ja;q=0.9' }));

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ toString: () => '' }),
  headers: () => Promise.resolve(new Headers({ 'accept-language': language.value })),
}));

vi.mock('../../server/auth', () => ({
  getSession: () => Promise.resolve(null),
}));

vi.mock('../../server/features/console', () => ({
  featureGate: () => Promise.resolve({ enabled: true }),
}));

async function homeProps(): Promise<ComponentProps<typeof HomeChat>> {
  const home = await HomePage({ searchParams: Promise.resolve({}) });
  if (!isValidElement<ComponentProps<typeof HomeChat>>(home)) {
    throw new Error('HomePage did not return the HomeChat boundary');
  }
  return home.props;
}

// UX-15 in #2086: the home chat is drawn in the reader's language from the first paint.
describe('HomePage locale', () => {
  it('hands the negotiated locale to the chat, and says why nothing can run in it', async () => {
    language.value = 'ja-JP,ja;q=0.9';
    const ja = await homeProps();
    expect(ja.locale).toBe('ja');
    expect(ja.agents).toEqual({
      kind: 'no-agents',
      reason: 'エージェントの保存先が設定されていないため、まだ何も実行できません。',
    });

    language.value = 'en-US,en;q=0.9';
    const en = await homeProps();
    expect(en.locale).toBe('en');
    expect(en.agents).toEqual({
      kind: 'no-agents',
      reason: 'No agent store is configured — nothing can run yet.',
    });
  });
});
