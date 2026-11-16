import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AgentTabs } from '../../../../components/agents/platforms';
import { AgentSchedulesScreen } from '../../../../components/agents/schedules';
import { FeatureSwitchedOff } from '../../../../components/shell/feature-off';
import AgentDetailPage from './page';

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers()),
}));

vi.mock('../../../../server/agents/restore-capability', () => ({
  resolveAgentRestoreCapability: () =>
    Promise.resolve({ canRestoreOwn: false, canRestoreOther: false, viewerPrincipalId: null }),
}));

const triggersOn = vi.hoisted(() => ({ value: true }));
vi.mock('../../../../server/features/console', () => ({
  featureGate: (feature: string) =>
    Promise.resolve(
      feature === 'triggers' && !triggersOn.value
        ? { enabled: false, installed: true, isOwner: true, workspaceName: 'Acme' }
        : { enabled: true },
    ),
}));

/** Every element in `node`, depth first. */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node, ...elements(node.props.children)];
}

async function page(tab: string): Promise<ReactElement[]> {
  return elements(
    await AgentDetailPage({
      params: Promise.resolve({ id: 'a1' }),
      searchParams: Promise.resolve({ tab }),
    }),
  );
}

// UX-18 in #2086: the Schedules tab follows the workspace's Triggers switch (ADR-0160).
describe('the agent page and the Triggers switch', () => {
  it('offers and opens the Schedules tab while triggers are on', async () => {
    triggersOn.value = true;
    const tree = await page('schedules');
    expect(tree.find((each) => each.type === AgentTabs)?.props).toMatchObject({ schedules: true });
    expect(tree.some((each) => each.type === AgentSchedulesScreen)).toBe(true);
  });

  it('hides the tab, and a deep link explains that triggers are off', async () => {
    triggersOn.value = false;
    const tree = await page('schedules');
    expect(tree.find((each) => each.type === AgentTabs)?.props).toMatchObject({ schedules: false });
    expect(tree.some((each) => each.type === AgentSchedulesScreen)).toBe(false);
    expect(tree.some((each) => each.type === FeatureSwitchedOff)).toBe(true);
  });

  it('leaves the other tabs alone while triggers are off', async () => {
    triggersOn.value = false;
    const tree = await page('platforms');
    expect(tree.some((each) => each.type === FeatureSwitchedOff)).toBe(false);
  });
});
