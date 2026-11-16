'use client';
import ticket_comment from '@/resources/ticket_comment';
import { ResourceList } from '@indx-workspace/app/react';

export default function TicketCommentsPage() {
  return <ResourceList resource={ticket_comment} />;
}
