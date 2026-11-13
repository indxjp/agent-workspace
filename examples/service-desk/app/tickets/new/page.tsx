'use client';
import ticket from '@/resources/ticket';
import { ResourceForm } from '@indx-workspace/app/react';

export default function NewTicketPage() {
  const saved = ({ id }: { readonly id: string }) => {
    window.location.assign(`/tickets/${id}`);
  };
  return <ResourceForm resource={ticket} cancelHref="/tickets" onSaved={saved} />;
}
