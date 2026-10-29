import { headers } from 'next/headers';

import { AgentArchivedNotice } from '../../../../components/agents/agent-archived';
import { AgentDetailScreen } from '../../../../components/agents/agent-detail';
import { AgentPlatformsScreen, AgentTabs } from '../../../../components/agents/platforms';
import { agentTab } from '../../../../components/agents/platforms-model';
import { AgentVersionsScreen } from '../../../../components/agents/versions';
import { versionsLocaleOf } from '../../../../components/agents/versions-messages';
import { resolveAgentRestoreCapability } from '../../../../server/agents/restore-capability';

export const dynamic = 'force-dynamic';

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const [{ id }, { tab }, requestHeaders, capability] = await Promise.all([
    params,
    searchParams,
    headers(),
    resolveAgentRestoreCapability(),
  ]);
  const locale = versionsLocaleOf(requestHeaders.get('accept-language'));
  const current = agentTab(tab);
  return (
    <>
      <AgentTabs agentId={id} current={current} locale={locale} />
      <AgentArchivedNotice agentId={id} locale={locale} capability={capability} />
      {current === 'versions' ? <AgentVersionsScreen agentId={id} locale={locale} /> : null}
      {current === 'platforms' ? <AgentPlatformsScreen agentId={id} locale={locale} /> : null}
      {current === 'configuration' ? <AgentDetailScreen agentId={id} /> : null}
    </>
  );
}
