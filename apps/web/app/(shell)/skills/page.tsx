import { SkillsScreen } from '../../../components/resources/resource-screens';
import { ScreenMain } from '../../../components/shell/screen-main';
import { switchedOffPanel } from '../feature-gate';

export const dynamic = 'force-dynamic';
export default async function SkillsPage() {
  const off = await switchedOffPanel('skills');
  if (off !== null) return off;
  return (
    <ScreenMain>
      <SkillsScreen />
    </ScreenMain>
  );
}
