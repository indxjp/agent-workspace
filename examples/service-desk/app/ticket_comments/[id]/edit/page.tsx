'use client';
import ticket_comment from '@/resources/ticket_comment';
import { ResourceFormLoader } from '@indx-workspace/app/react';
import { use } from 'react';

export default function EditTicketCommentPage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const saved = () => window.location.assign(`/ticket_comments/${id}`);
  return <ResourceFormLoader resource={ticket_comment} id={id} cancelHref={`/ticket_comments/${id}`} onSaved={saved} />;
}
