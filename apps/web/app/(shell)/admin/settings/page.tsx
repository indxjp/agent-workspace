import { headers } from 'next/headers';

import { SettingsScreen } from '../../../../components/resources/resource-screens';
import { WorkspaceModelDefaultCard } from '../../../../components/models/workspace-default-card';
import { versionsLocaleOf } from '../../../../components/agents/versions-messages';
import { FeaturesCard } from '../../../../components/workspace/features-card';
import { getSession } from '../../../../server/auth';
import { resolveIdentity } from '../../../../server/features/console';

export const dynamic = 'force-dynamic';
export default async function SettingsPage() {
  const session = await getSession();
  const identity = session === null ? null : await resolveIdentity(session);
  const locale = versionsLocaleOf((await headers()).get('accept-language'));
  return (
    <>
      <SettingsScreen />
      {/* Issue #130: the workspace-wide model default lives on this existing screen rather than
          waiting on #120's dedicated workspace settings screen. */}
      <div className="mt-4">
        <WorkspaceModelDefaultCard />
      </div>
      {/* ADR-0160 D8, 06 J4 (#1497): on the existing Settings screen, like the model default card.
          With no resolved workspace there is nothing to switch, so the card is not shown. */}
      {identity === null ? null : (
        <div className="mt-4">
          <FeaturesCard
            workspaceId={identity.workspaceId}
            isOwner={identity.role === 'owner'}
            locale={locale}
          />
        </div>
      )}
    </>
  );
}
