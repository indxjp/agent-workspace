/**
 * `/agents` — spec §17, §34, §46. The seam between the route and `components/agents/agents-list.tsx`,
 * which does the fetching and the layout; see that file's header for what this screen shows and why.
 */
import { headers } from 'next/headers';

import { AgentsListScreen } from '../../../components/agents/agents-list';
import { versionsLocaleOf } from '../../../components/agents/versions-messages';

export default async function AgentsPage() {
  const locale = versionsLocaleOf((await headers()).get('accept-language'));
  return <AgentsListScreen locale={locale} />;
}
