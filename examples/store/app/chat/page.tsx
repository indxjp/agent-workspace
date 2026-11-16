import { appRuntime } from '@indx-workspace/app/server';
import { cookies } from 'next/headers';

import { CATALOG } from '../../catalog/index.ts';
import { LANG_COOKIE, langOf } from '../lang';
import { VisitorPage } from '../visitor-page';

export default async function ChatPage() {
  const lang = langOf((await cookies()).get(LANG_COOKIE)?.value);
  const entries = CATALOG.flatMap((entry) =>
    entry.status === 'live'
      ? [{ agent: entry.demo.agent, text: entry.name[lang], href: `/agents/${entry.slug}#try` }]
      : [],
  );
  const view = { kind: 'chat', entries } as const;
  return <VisitorPage view={view} lang={lang} platformUrl={appRuntime().awUrl} />;
}
