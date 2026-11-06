'use client';
import deal from '@/resources/deal';
import { AgentPanel, ResourceDetailLoader } from '@indx-workspace/app/react';
import { use } from 'react';

import { theme } from '../../theme';

/** The sales assistant, as the panel beside a deal offers it, in the portal's language. */
const AGENTS = {
  en: [{ name: 'sales-assistant', label: 'Sales assistant' }],
  ja: [{ name: 'sales-assistant', label: '営業アシスタント' }],
} as const;

export default function DealPage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const panel = <AgentPanel resource={deal} recordId={id} agents={AGENTS[theme.locale]} />;
  return (
    <ResourceDetailLoader resource={deal} id={id} editHref={`/deals/${id}/edit`} aside={panel} />
  );
}
