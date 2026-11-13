import { headers } from 'next/headers';

import { versionsLocaleOf } from '../../../../../components/agents/versions-messages';
import { AddProviderScreen } from '../../../../../components/models/add-provider-screen';

export const dynamic = 'force-dynamic';

export default async function AddProviderPage() {
  // The reader's language (UX-15 in #2086), negotiated as the shell negotiates it.
  const locale = versionsLocaleOf((await headers()).get('accept-language'));
  return <AddProviderScreen locale={locale} />;
}
