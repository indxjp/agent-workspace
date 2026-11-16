import { headers } from 'next/headers';

import { versionsLocaleOf } from '../../../../components/agents/versions-messages';
import { ApiKeysScreen } from '../../../../components/resources/resource-screens';
import { ScreenMain } from '../../../../components/shell/screen-main';

export const dynamic = 'force-dynamic';
export default async function ApiKeysPage() {
  // The reader's language (UX-15 in #2086), negotiated as the shell negotiates it.
  const locale = versionsLocaleOf((await headers()).get('accept-language'));
  return (
    <ScreenMain>
      <ApiKeysScreen locale={locale} />
    </ScreenMain>
  );
}
