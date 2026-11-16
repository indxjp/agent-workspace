'use client';
/**
 * The desk's knowledge base (issue #1521): the page tree beside the chosen page, which a person
 * edits and a writer agent rewrites. A save, a restore or the agent's change loads the tree again,
 * so a new title shows in it.
 */
import page from '../resources/page';
import { AppTheme, PageTree, PageView, type AppLocale } from '@indx-workspace/app/react';
import { useMemo, useState, type ReactNode } from 'react';

import { deskWords } from './words';

export function WikiPage(props: {
  readonly locale: AppLocale;
  readonly platformUrl: string;
}): ReactNode {
  const { locale } = props;
  const words = deskWords(locale);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const agents = useMemo(() => [{ name: 'writer', label: words.agents.writer }], [words]);
  return (
    <AppTheme locale={locale}>
      <main className="desk-wiki">
        <PageTree
          pages={page}
          selectedId={selected}
          onSelect={setSelected}
          version={version}
          locale={locale}
        />
        {selected === null ? (
          <section>
            <h1>{words.wikiHeading}</h1>
            <p>{words.wikiChoose}</p>
          </section>
        ) : (
          <PageView
            key={selected}
            resource={page}
            id={selected}
            agents={agents}
            platformUrl={props.platformUrl}
            personName={() => 'Desk person'}
            onChanged={() => setVersion((current) => current + 1)}
            locale={locale}
          />
        )}
      </main>
    </AppTheme>
  );
}
