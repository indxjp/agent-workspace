import { SkillDetailScreen } from '../../../../components/resources/resource-screens';

export const dynamic = 'force-dynamic';
export default async function SkillPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <SkillDetailScreen name={name} />;
}
