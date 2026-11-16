import { headers } from 'next/headers';

import { AgentArchivedNotice } from '../../../../components/agents/agent-archived';
import {
  AgentRestoreScope,
  RemountOnRestore,
} from '../../../../components/agents/agent-restore-scope';
import { AgentDetailScreen } from '../../../../components/agents/agent-detail';
import { AgentPlatformsScreen, AgentTabs } from '../../../../components/agents/platforms';
import { AgentSchedulesScreen } from '../../../../components/agents/schedules';
import { agentTab } from '../../../../components/agents/platforms-model';
import { AgentVersionsScreen } from '../../../../components/agents/versions';
import { versionsLocaleOf } from '../../../../components/agents/versions-messages';
import { resolveAgentRestoreCapability } from '../../../../server/agents/restore-capability';
import { featureGate } from '../../../../server/features/console';
import { switchedOffPanel } from '../../feature-gate';

export const dynamic = 'force-dynamic';

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const [{ id }, { tab }, requestHeaders, capability, triggers] = await Promise.all([
    params,
    searchParams,
    headers(),
    resolveAgentRestoreCapability(),
    featureGate('triggers'),
  ]);
  const locale = versionsLocaleOf(requestHeaders.get('accept-language'));
  const current = agentTab(tab);
  // UX-18 in #2086: a deep link to the Schedules tab while triggers are off explains instead.
  const schedulesOff = current === 'schedules' ? await switchedOffPanel('triggers') : null;
  return (
    <AgentRestoreScope>
      <AgentTabs agentId={id} current={current} locale={locale} schedules={triggers.enabled} />
      <AgentArchivedNotice agentId={id} locale={locale} capability={capability} />
      <RemountOnRestore>
        {current === 'versions' ? <AgentVersionsScreen agentId={id} locale={locale} /> : null}
        {current === 'platforms' ? <AgentPlatformsScreen agentId={id} locale={locale} /> : null}
        {current === 'schedules'
          ? (schedulesOff ?? <AgentSchedulesScreen agentId={id} locale={locale} />)
          : null}
        {current === 'configuration' ? <AgentDetailScreen agentId={id} locale={locale} /> : null}
      </RemountOnRestore>
    </AgentRestoreScope>
  );
}
