'use client';
import channel from '@/resources/channel';
import { ResourceList } from '@indx-workspace/app/react';

export default function ChannelsPage() {
  return <ResourceList resource={channel} />;
}
