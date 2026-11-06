'use client';
import room from '../resources/room';
import message from '../resources/message';
import { AppTheme, ChannelView, resourceClient, type AppLocale } from '@indx-workspace/app/react';
import { useEffect, useState, type ReactNode } from 'react';

import { DESK_MEMBERS, DESK_ROOM_TITLE } from './members';
import { deskWords } from './words';

/** The desk's channel page: the seeded room's messages, live (issue #1519). */
export function ChannelPage({ locale }: { readonly locale: AppLocale }): ReactNode {
  const [roomId, setRoomId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void resourceClient(room)
      .list()
      .then((page) => {
        const found = page.items.find((each) => each.title === DESK_ROOM_TITLE);
        if (live && found !== undefined) setRoomId(found.id);
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <AppTheme locale={locale}>
      <main>
        <h1>{deskWords(locale).channelHeading}</h1>
        {roomId === null ? null : (
          <ChannelView
            channel="message"
            resource={message}
            keyValue={roomId}
            members={DESK_MEMBERS}
            locale={locale}
          />
        )}
      </main>
    </AppTheme>
  );
}
