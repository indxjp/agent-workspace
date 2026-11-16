import { TicketsBoard } from '../../components/tickets-board';
import { localeOf } from '../../components/words';
import type { ReactNode } from 'react';

export default async function TicketsPage(props: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { lang } = await props.searchParams;
  return <TicketsBoard locale={localeOf(lang)} />;
}
