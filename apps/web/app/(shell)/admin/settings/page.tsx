import { SettingsScreen } from '../../../../components/resources/resource-screens';
import { WorkspaceModelDefaultCard } from '../../../../components/models/workspace-default-card';

export const dynamic = 'force-dynamic';
export default function SettingsPage() {
  return (
    <>
      <SettingsScreen />
      {/* Issue #130: the workspace-wide model default lives on this existing screen rather than
          waiting on #120's dedicated workspace settings screen. */}
      <div className="mt-4">
        <WorkspaceModelDefaultCard />
      </div>
    </>
  );
}
