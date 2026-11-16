'use client';
import ticket from '@/resources/ticket';
import { ResourceBoard } from '@indx-workspace/app/react';

export default function TicketsPage() {
  return <ResourceBoard resource={ticket} />;
}
