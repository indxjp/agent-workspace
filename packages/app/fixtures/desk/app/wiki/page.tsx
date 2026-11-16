import { localeOf } from '../../components/words';
import { WikiPage } from '../../components/wiki-page';
import { DESK_PLATFORM_URL } from '../../server/desk';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

export default async function DeskWikiPage(props: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { lang } = await props.searchParams;
  return <WikiPage locale={localeOf(lang)} platformUrl={DESK_PLATFORM_URL} />;
}
