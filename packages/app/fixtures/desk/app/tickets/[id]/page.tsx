import { TicketDetail } from '../../../components/ticket-detail';
import { localeOf } from '../../../components/words';
import type { ReactNode } from 'react';

export default async function TicketPage(props: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const [{ id }, { lang }] = await Promise.all([props.params, props.searchParams]);
  return <TicketDetail id={id} locale={localeOf(lang)} />;
}
