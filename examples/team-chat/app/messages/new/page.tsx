'use client';
import message from '@/resources/message';
import { ResourceForm } from '@indx-workspace/app/react';

export default function NewMessagePage() {
  const saved = ({ id }: { readonly id: string }) => {
    window.location.assign(`/messages/${id}`);
  };
  return <ResourceForm resource={message} cancelHref="/messages" onSaved={saved} />;
}
