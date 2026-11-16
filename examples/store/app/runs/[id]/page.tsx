import { appRuntime } from '@indx-workspace/app/server';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import { LANG_COOKIE, langOf } from '../../lang';
import { VisitorPage } from '../../visitor-page';

/** A run id as the platform issues them: a UUID. Anything else is no run. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export default async function RunPage({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!RUN_ID.test(id)) notFound();
  const lang = langOf((await cookies()).get(LANG_COOKIE)?.value);
  return <VisitorPage view={{ kind: 'run', id }} lang={lang} platformUrl={appRuntime().awUrl} />;
}
