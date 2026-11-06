'use client';
import channel from '@/resources/channel';
import { ResourceFormLoader } from '@indx-workspace/app/react';
import { use } from 'react';

export default function EditChannelPage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const saved = () => window.location.assign(`/channels/${id}`);
  return <ResourceFormLoader resource={channel} id={id} cancelHref={`/channels/${id}`} onSaved={saved} />;
}
