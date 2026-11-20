import { headers } from 'next/headers';

import { versionsLocaleOf } from '../../../../components/agents/versions-messages';
import { SkillDetailScreen } from '../../../../components/resources/resource-screens';
import { ScreenMain } from '../../../../components/shell/screen-main';
import { switchedOffPanel } from '../../feature-gate';

export const dynamic = 'force-dynamic';
export default async function SkillPage({ params }: { params: Promise<{ name: string }> }) {
  const off = await switchedOffPanel('skills');
  if (off !== null) return off;
  const { name } = await params;
  // The reader's language (UX-15 in #2086), negotiated as the shell negotiates it.
  const locale = versionsLocaleOf((await headers()).get('accept-language'));
  return (
    <ScreenMain>
      <SkillDetailScreen name={name} locale={locale} />
    </ScreenMain>
  );
}
