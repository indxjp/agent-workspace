'use client';
import page from '@/resources/page';
import { PageTree, PageView, type AgentPanelAgent } from '@indx-workspace/app/react';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';

import { theme } from '../../theme';

// The agent the page offers ("Rewrite with <agent>", "Summarize into new page"), in the portal's
// language; app/api/agent-panel/[...path]/route.ts serves its panel.
const AGENTS: Readonly<Record<'en' | 'ja', readonly AgentPanelAgent[]>> = {
  en: [{ name: 'writer', label: 'Writer' }],
  ja: [{ name: 'writer', label: 'ライター' }],
};
const agents = AGENTS[theme.locale];

/** One page of the wiki beside its space's tree. */
export default function WikiPageView(props: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = use(props.params);
  const query = use(props.searchParams);
  const spaceId = typeof query['space'] === 'string' ? query['space'] : undefined;
  const router = useRouter();
  const [version, setVersion] = useState(0);
  const suffix = spaceId === undefined ? '' : `?space=${encodeURIComponent(spaceId)}`;
  return (
    <main>
      <PageTree
        pages={page}
        spaceId={spaceId}
        selectedId={id}
        version={version}
        locale={theme.locale}
        onSelect={(next) => {
          router.push(`/wiki/${encodeURIComponent(next)}${suffix}`);
        }}
      />
      <PageView
        resource={page}
        id={id}
        agents={agents}
        locale={theme.locale}
        onChanged={() => {
          setVersion((current) => current + 1);
        }}
      />
    </main>
  );
}
