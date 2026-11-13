'use client';
import channel from '@/resources/channel';
import { ResourceForm } from '@indx-workspace/app/react';

export default function NewChannelPage() {
  const saved = ({ id }: { readonly id: string }) => {
    window.location.assign(`/channels/${id}`);
  };
  return <ResourceForm resource={channel} cancelHref="/channels" onSaved={saved} />;
}
