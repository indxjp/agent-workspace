'use client';
import ticket_comment from '@/resources/ticket_comment';
import { ResourceForm } from '@indx-workspace/app/react';

export default function NewTicketCommentPage() {
  const saved = ({ id }: { readonly id: string }) => {
    window.location.assign(`/ticket_comments/${id}`);
  };
  return <ResourceForm resource={ticket_comment} cancelHref="/ticket_comments" onSaved={saved} />;
}
