import { SkillDetailScreen } from '../../../../components/resources/resource-screens';
import { switchedOffPanel } from '../../feature-gate';

export const dynamic = 'force-dynamic';
export default async function SkillPage({ params }: { params: Promise<{ name: string }> }) {
  const off = await switchedOffPanel('skills');
  if (off !== null) return off;
  const { name } = await params;
  return <SkillDetailScreen name={name} />;
}
