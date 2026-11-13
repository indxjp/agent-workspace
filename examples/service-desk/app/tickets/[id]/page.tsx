'use client';
import ticket from '@/resources/ticket';
import { AgentPanel, ResourceDetailLoader } from '@indx-workspace/app/react';
import { use } from 'react';

import { theme } from '../../theme';

/** The desk's agents as the panel offers them, in the portal's language. */
const AGENTS = {
  en: [
    { name: 'triage', label: 'Triage' },
    { name: 'closer', label: 'Closer' },
  ],
  ja: [
    { name: 'triage', label: 'トリアージ' },
    { name: 'closer', label: 'クローズ担当' },
  ],
} as const;

export default function TicketPage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const panel = <AgentPanel resource={ticket} recordId={id} agents={AGENTS[theme.locale]} />;
  return (
    <ResourceDetailLoader resource={ticket} id={id} editHref={`/tickets/${id}/edit`} aside={panel} />
  );
}
