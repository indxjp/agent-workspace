'use client';
import ticket from '@/resources/ticket';
import { ResourceFormLoader } from '@indx-workspace/app/react';
import { use } from 'react';

export default function EditTicketPage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const saved = () => window.location.assign(`/tickets/${id}`);
  return <ResourceFormLoader resource={ticket} id={id} cancelHref={`/tickets/${id}`} onSaved={saved} />;
}
