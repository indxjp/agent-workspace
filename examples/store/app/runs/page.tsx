import { appRuntime } from '@indx-workspace/app/server';
import { cookies } from 'next/headers';

import { LANG_COOKIE, langOf } from '../lang';
import { VisitorPage } from '../visitor-page';

export default async function RunsPage() {
  const lang = langOf((await cookies()).get(LANG_COOKIE)?.value);
  return <VisitorPage view={{ kind: 'runs' }} lang={lang} platformUrl={appRuntime().awUrl} />;
}
