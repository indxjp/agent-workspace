import { headers } from 'next/headers';

import { versionsLocaleOf } from '../../../components/agents/versions-messages';
import { SkillsScreen } from '../../../components/resources/resource-screens';
import { ScreenMain } from '../../../components/shell/screen-main';
import { switchedOffPanel } from '../feature-gate';

export const dynamic = 'force-dynamic';
export default async function SkillsPage() {
  const off = await switchedOffPanel('skills');
  if (off !== null) return off;
  // The reader's language (UX-15 in #2086), negotiated as the shell negotiates it.
  const locale = versionsLocaleOf((await headers()).get('accept-language'));
  return (
    <ScreenMain>
      <SkillsScreen locale={locale} />
    </ScreenMain>
  );
}
