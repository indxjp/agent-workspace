'use client';
import page from '@/resources/page';
import space from '@/resources/space';
import { PageTree, ResourceList } from '@indx-workspace/app/react';
import { useRouter } from 'next/navigation';
import { use } from 'react';

import { theme } from '../theme';

const WORDS = {
  en: { spaces: 'Spaces', newSpace: 'New space', allSpaces: 'All spaces' },
  ja: { spaces: 'スペース', newSpace: '新しいスペース', allSpaces: 'すべてのスペース' },
} as const;

/** The wiki: its spaces, and with `?space=<id>` that space's page tree. */
export default function WikiPage(props: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = use(props.searchParams);
  const spaceId = typeof query['space'] === 'string' ? query['space'] : undefined;
  const router = useRouter();
  const words = WORDS[theme.locale];
  if (spaceId === undefined) {
    return (
      <main>
        <h1>{words.spaces}</h1>
        <p>
          <a href="/spaces/new">{words.newSpace}</a>
        </p>
        <ResourceList
          resource={space}
          locale={theme.locale}
          detailHref={(record) => `/wiki?space=${encodeURIComponent(record.id)}`}
        />
      </main>
    );
  }
  return (
    <main>
      <p>
        <a href="/wiki">{words.allSpaces}</a>
      </p>
      <PageTree
        pages={page}
        spaceId={spaceId}
        selectedId={null}
        locale={theme.locale}
        onSelect={(id) => {
          router.push(`/wiki/${encodeURIComponent(id)}?space=${encodeURIComponent(spaceId)}`);
        }}
      />
    </main>
  );
}
