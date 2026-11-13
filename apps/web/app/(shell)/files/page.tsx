import { headers } from 'next/headers';

import { versionsLocaleOf } from '../../../components/agents/versions-messages';
import { FilesScreen } from '../../../components/resources/resource-screens';
import { ScreenMain } from '../../../components/shell/screen-main';
import { switchedOffPanel } from '../feature-gate';

export const dynamic = 'force-dynamic';
export default async function FilesPage() {
  const off = await switchedOffPanel('files');
  if (off !== null) return off;
  const locale = versionsLocaleOf((await headers()).get('accept-language'));
  return (
    <ScreenMain>
      <FilesScreen locale={locale} />
    </ScreenMain>
  );
}
