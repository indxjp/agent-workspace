import { headers } from 'next/headers';

import { versionsLocaleOf } from '../../../../components/agents/versions-messages';
import { ModelsScreen } from '../../../../components/models/models-screen';

export const dynamic = 'force-dynamic';

export default async function ModelsPage() {
  // The reader's language (UX-15 in #2086), negotiated as the shell negotiates it.
  const locale = versionsLocaleOf((await headers()).get('accept-language'));
  return <ModelsScreen locale={locale} />;
}
