import { isValidElement, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { HomeChat } from '../../components/composer/home-chat';
import HomePage from './page';

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ toString: () => '' }),
  headers: () => Promise.resolve(new Headers()),
}));

vi.mock('../../server/auth', () => ({
  getSession: () => Promise.resolve(null),
}));

const filesOn = vi.hoisted(() => ({ value: true }));
vi.mock('../../server/features/console', () => ({
  featureGate: (feature: string) =>
    Promise.resolve(
      feature === 'files' && !filesOn.value
        ? { enabled: false, installed: true, isOwner: true, workspaceName: 'Acme' }
        : { enabled: true },
    ),
}));

async function homeProps(): Promise<ComponentProps<typeof HomeChat>> {
  const home = await HomePage({ searchParams: Promise.resolve({}) });
  if (!isValidElement<ComponentProps<typeof HomeChat>>(home)) {
    throw new Error('HomePage did not return the HomeChat boundary');
  }
  return home.props;
}

// UX-21 in #2086: the composer learns from the Files switch whether to offer + Files and Attach file.
describe('HomePage and the Files switch', () => {
  it('tells the composer that Files is off when the workspace switched it off', async () => {
    filesOn.value = false;
    expect((await homeProps()).filesEnabled).toBe(false);
  });

  it('tells the composer that Files is on otherwise', async () => {
    filesOn.value = true;
    expect((await homeProps()).filesEnabled).toBe(true);
  });
});
