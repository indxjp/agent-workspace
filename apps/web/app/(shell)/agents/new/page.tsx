/**
 * `/agents/new` — spec §17, §46's "enter instructions → select Claude" step. The seam between the
 * route and `components/agents/agent-form.tsx`; see that file's header and `components/agents/model.ts`
 * for what this screen asks for and why it is not the full five-step wizard.
 */
import { headers } from 'next/headers';

import { NewAgentRoute } from '../../../../components/agents/builder-mode-route';
import { versionsLocaleOf } from '../../../../components/agents/versions-messages';
import { featureGate } from '../../../../server/features/console';

export const dynamic = 'force-dynamic';
export default async function NewAgentPage() {
  // The Builder chat hides + Files and Attach file while Files is off (UX-21 in #2086).
  const files = await featureGate('files');
  // The reader's language (UX-15 in #2086), negotiated as the shell negotiates it.
  const locale = versionsLocaleOf((await headers()).get('accept-language'));
  return <NewAgentRoute filesEnabled={files.enabled} locale={locale} />;
}
