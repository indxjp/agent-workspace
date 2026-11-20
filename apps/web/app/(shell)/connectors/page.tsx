import { headers } from 'next/headers';

import { versionsLocaleOf } from '../../../components/agents/versions-messages';
import { ConnectorsScreen } from '../../../components/resources/resource-screens';
import { ScreenMain } from '../../../components/shell/screen-main';
import { switchedOffPanel } from '../feature-gate';

export const dynamic = 'force-dynamic';
export default async function ConnectorsPage() {
  const off = await switchedOffPanel('connectors');
  if (off !== null) return off;
  // The reader's language (UX-15 in #2086), negotiated as the shell negotiates it.
  const locale = versionsLocaleOf((await headers()).get('accept-language'));
  return (
    <ScreenMain>
      <ConnectorsScreen locale={locale} />
    </ScreenMain>
  );
}
