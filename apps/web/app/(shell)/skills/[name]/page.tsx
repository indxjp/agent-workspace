import { SkillDetailScreen } from '../../../../components/resources/resource-screens';
import { ScreenMain } from '../../../../components/shell/screen-main';
import { switchedOffPanel } from '../../feature-gate';

export const dynamic = 'force-dynamic';
export default async function SkillPage({ params }: { params: Promise<{ name: string }> }) {
  const off = await switchedOffPanel('skills');
  if (off !== null) return off;
  const { name } = await params;
  return (
    <ScreenMain>
      <SkillDetailScreen name={name} />
    </ScreenMain>
  );
}
