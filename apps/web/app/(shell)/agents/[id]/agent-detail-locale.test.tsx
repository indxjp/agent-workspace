import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AgentDetailScreen } from '../../../../components/agents/agent-detail';
import AgentDetailPage from './page';

const language = vi.hoisted(() => ({ value: 'en-US' }));
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ 'accept-language': language.value })),
}));
vi.mock('../../../../server/agents/restore-capability', () => ({
  resolveAgentRestoreCapability: () =>
    Promise.resolve({ canRestoreOwn: false, canRestoreOther: false, viewerPrincipalId: null }),
}));
vi.mock('../../../../server/features/console', () => ({
  featureGate: () => Promise.resolve({ enabled: true }),
}));

/** Every element in `node`, depth first. */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node, ...elements(node.props.children)];
}

async function configuration(acceptLanguage: string): Promise<ReactElement | undefined> {
  language.value = acceptLanguage;
  const tree = elements(
    await AgentDetailPage({
      params: Promise.resolve({ id: 'a1' }),
      searchParams: Promise.resolve({ tab: 'configuration' }),
    }),
  );
  return tree.find((each) => each.type === AgentDetailScreen);
}

// UX-15 in #2086: the Configuration tab reads the reader's language as the other tabs do.
describe('the agent page and the reader’s language', () => {
  it('gives the Configuration tab Japanese for a Japanese reader', async () => {
    expect((await configuration('ja,en;q=0.8'))?.props).toMatchObject({
      agentId: 'a1',
      locale: 'ja',
    });
  });

  it('gives it English otherwise', async () => {
    expect((await configuration('en-US'))?.props).toMatchObject({ locale: 'en' });
  });
});
