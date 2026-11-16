import { isValidElement, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { NewAgentRoute } from '../../../../components/agents/builder-mode-route';
import NewAgentPage from './page';

const filesOn = vi.hoisted(() => ({ value: true }));
const acceptLanguage = vi.hoisted((): { value: string | null } => ({ value: 'en' }));
vi.mock('next/headers', () => ({
  headers: () =>
    Promise.resolve(
      new Headers(acceptLanguage.value === null ? {} : { 'accept-language': acceptLanguage.value }),
    ),
}));
vi.mock('../../../../server/features/console', () => ({
  featureGate: () =>
    Promise.resolve(
      filesOn.value
        ? { enabled: true }
        : { enabled: false, installed: true, isOwner: true, workspaceName: 'Acme' },
    ),
}));

async function routeProps(): Promise<ComponentProps<typeof NewAgentRoute>> {
  const page = await NewAgentPage();
  if (!isValidElement<ComponentProps<typeof NewAgentRoute>>(page)) {
    throw new Error('NewAgentPage did not return the NewAgentRoute boundary');
  }
  return page.props;
}

// UX-21 in #2086: the Builder chat learns from the Files switch whether to offer + Files.
describe('NewAgentPage and the Files switch', () => {
  it('passes the Files switch to the route, off and on', async () => {
    filesOn.value = false;
    expect((await routeProps()).filesEnabled).toBe(false);
    filesOn.value = true;
    expect((await routeProps()).filesEnabled).toBe(true);
  });

  // UX-15 in #2086: the screen speaks the reader's language, as the shell negotiates it.
  it("passes the reader's language to the route", async () => {
    acceptLanguage.value = 'ja-JP,ja;q=0.9,en;q=0.8';
    expect((await routeProps()).locale).toBe('ja');
    acceptLanguage.value = 'en-US';
    expect((await routeProps()).locale).toBe('en');
    acceptLanguage.value = null;
    expect((await routeProps()).locale).toBe('en');
  });
});
