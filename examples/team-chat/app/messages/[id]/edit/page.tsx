'use client';
import message from '@/resources/message';
import { ResourceFormLoader } from '@indx-workspace/app/react';
import { use } from 'react';

export default function EditMessagePage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const saved = () => window.location.assign(`/messages/${id}`);
  return <ResourceFormLoader resource={message} id={id} cancelHref={`/messages/${id}`} onSaved={saved} />;
}
