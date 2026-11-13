import { headers } from 'next/headers';

import { versionsLocaleOf } from '../../../../components/agents/versions-messages';
import { SharedLinksScreen } from '../../../../components/shares/shared-links-screen';
import { switchedOffPanel } from '../../feature-gate';
export default async function SharedLinksPage() {
  const off = await switchedOffPanel('sharing');
  if (off !== null) return off;
  // The reader's language (UX-15 in #2086), negotiated as the shell negotiates it.
  const locale = versionsLocaleOf((await headers()).get('accept-language'));
  return <SharedLinksScreen locale={locale} />;
}
