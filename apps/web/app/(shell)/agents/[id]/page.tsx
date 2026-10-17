import { headers } from 'next/headers';

import { AgentDetailScreen } from '../../../../components/agents/agent-detail';
import { AgentPlatformsScreen, AgentTabs } from '../../../../components/agents/platforms';
import { agentTab } from '../../../../components/agents/platforms-model';
import { AgentVersionsScreen } from '../../../../components/agents/versions';
import { versionsLocaleOf } from '../../../../components/agents/versions-messages';

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  const locale = versionsLocaleOf((await headers()).get('accept-language'));
  const current = agentTab(tab);
  return (
    <>
      <AgentTabs agentId={id} current={current} locale={locale} />
      {current === 'versions' ? <AgentVersionsScreen agentId={id} locale={locale} /> : null}
      {current === 'platforms' ? <AgentPlatformsScreen agentId={id} locale={locale} /> : null}
      {current === 'configuration' ? <AgentDetailScreen agentId={id} /> : null}
    </>
  );
}
