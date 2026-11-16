'use client';
import message from '@/resources/message';
import { ResourceDetailLoader } from '@indx-workspace/app/react';
import { use } from 'react';

export default function MessagePage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  return <ResourceDetailLoader resource={message} id={id} editHref={`/messages/${id}/edit`} />;
}
