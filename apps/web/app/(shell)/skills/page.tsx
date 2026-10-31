import { SkillsScreen } from '../../../components/resources/resource-screens';
import { switchedOffPanel } from '../feature-gate';

export const dynamic = 'force-dynamic';
export default async function SkillsPage() {
  const off = await switchedOffPanel('skills');
  if (off !== null) return off;
  return <SkillsScreen />;
}
