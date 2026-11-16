import { ChannelPage } from '../../components/channel-page';
import { localeOf } from '../../components/words';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

export default async function DeskChannelPage(props: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { lang } = await props.searchParams;
  return <ChannelPage locale={localeOf(lang)} />;
}
