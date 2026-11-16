'use client';
import ticket_comment from '@/resources/ticket_comment';
import { ResourceDetailLoader } from '@indx-workspace/app/react';
import { use } from 'react';

export default function TicketCommentPage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  return <ResourceDetailLoader resource={ticket_comment} id={id} editHref={`/ticket_comments/${id}/edit`} />;
}
