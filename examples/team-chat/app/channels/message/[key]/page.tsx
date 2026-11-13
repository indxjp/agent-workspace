'use client';
import message from '@/resources/message';
import { ChannelView } from '@indx-workspace/app/react';
import { use } from 'react';

export default function MessageChannelPage(props: {
  readonly params: Promise<{ key: string }>;
}) {
  const { key } = use(props.params);
  return <ChannelView channel="message" resource={message} keyValue={key} />;
}
