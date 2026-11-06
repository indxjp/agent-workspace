'use client';
import { theme } from '@/app/theme';
import channel from '@/resources/channel';
import { ResourceDetailLoader } from '@indx-workspace/app/react';
import { use } from 'react';

const OPEN_MESSAGES = { en: 'Open the messages', ja: 'メッセージを開く' } as const;

export default function ChannelPage(props: { readonly params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  return (
    <>
      <ResourceDetailLoader resource={channel} id={id} editHref={`/channels/${id}/edit`} />
      <p>
        <a href={`/channels/message/${id}`}>{OPEN_MESSAGES[theme.locale]}</a>
      </p>
    </>
  );
}
