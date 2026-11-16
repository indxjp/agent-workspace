import { appRuntime } from '@indx-workspace/app/server';
import { cookies } from 'next/headers';

import { AREAS, CATALOG, COUNTS, FEATURED, type CatalogEntry } from '../catalog/index.ts';
import { recordingFor } from '../catalog/recording.ts';
import { RECORDINGS } from '../catalog/recordings.generated.ts';
import { RecordingView } from './agents/[slug]/try/recording-view';
import { filterHref, isFiltered, parseFilter, shelvesOf, type Filter, type Query } from './browse';
import { LANG_COOKIE, langOf, pick, type Lang } from './lang';
import { tr } from './text';
import { maintenanceSlugs, verificationLabel } from './verification';

export const dynamic = 'force-dynamic';

function Card({
  entry,
  lang,
  maintenance,
}: {
  readonly entry: CatalogEntry;
  readonly lang: Lang;
  readonly maintenance: readonly string[];
}) {
  const t = tr(lang);
  return (
    <li className="aw-app-card">
      <h3 className="aw-app-card-title">
        <a href={`/agents/${entry.slug}`}>{pick(entry.name, lang)}</a>
      </h3>
      <p>{pick(entry.summary, lang)}</p>
      <span className="aw-app-badge">
        {entry.status === 'live' ? t('今すぐ試せる', 'Try now') : t('近日公開', 'Coming soon')}
      </span>
      {entry.status === 'live' ? (
        <small data-testid="card-verification">
          {verificationLabel(entry.slug, lang, maintenance)}
        </small>
      ) : null}
    </li>
  );
}

/** The area and status links of the filter bar; the current ones are marked. */
function Filters({ filter, lang }: { readonly filter: Filter; readonly lang: Lang }) {
  const t = tr(lang);
  const statuses = [
    { value: null, label: t('すべて', 'All') },
    { value: 'live', label: t('今すぐ試せる', 'Try now') },
    { value: 'soon', label: t('近日公開', 'Coming soon') },
  ] as const;
  return (
    <nav aria-label={t('絞り込み', 'Filters')}>
      <ul className="store-filters" aria-label={t('分野', 'Area')}>
        <li>
          <a href={filterHref({ ...filter, cat: null })} aria-current={filter.cat === null}>
            {t('すべての分野', 'All areas')}
          </a>
        </li>
        {AREAS.map((area) => (
          <li key={area.id}>
            <a href={filterHref({ ...filter, cat: area.id })} aria-current={filter.cat === area.id}>
              {pick(area.name, lang)}
            </a>
          </li>
        ))}
      </ul>
      <ul className="store-filters" aria-label={t('状態', 'Status')}>
        {statuses.map(({ value, label }) => (
          <li key={label}>
            <a
              href={filterHref({ ...filter, status: value })}
              aria-current={filter.status === value}
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default async function HomePage({
  searchParams,
}: {
  readonly searchParams: Promise<Query>;
}) {
  const lang = langOf((await cookies()).get(LANG_COOKIE)?.value);
  const t = tr(lang);
  const filter = parseFilter(await searchParams);
  const shelves = shelvesOf(CATALOG, filter);
  const maintenance = await maintenanceSlugs(appRuntime().awUrl);
  return (
    <main className="store-main">
      <section className="store-hero" aria-labelledby="hero-title">
        <h1 id="hero-title">
          {t(
            '自社の仕事に合う AI エージェントを、見つけて、試して、導入する',
            'Find, try and install AI agents that fit your work',
          )}
        </h1>
        <ul className="store-numbers" aria-label={t('ストアの規模', 'The store in numbers')}>
          <li>
            <strong>{COUNTS.total}</strong> {t('エージェント', 'agents')}
          </li>
          <li>
            <strong>{COUNTS.live}</strong> {t('今すぐ試せる', 'to try now')}
          </li>
          <li>
            <strong>{COUNTS.areas}</strong> {t('分野', 'areas')}
          </li>
        </ul>
        <aside className="store-featured" aria-labelledby="featured-title">
          <p className="aw-app-badge">{t('注目（サンプル）', 'Featured (sample)')}</p>
          <h2 id="featured-title">
            <a href={`/agents/${FEATURED.slug}`}>{pick(FEATURED.name, lang)}</a>
          </h2>
          <p>{pick(FEATURED.demo.moment, lang)}</p>
          <p>
            {t('最初の一言の例：', 'First thing to ask: ')}
            <q>{pick(FEATURED.demo.prompts[0] ?? FEATURED.demo.moment, lang)}</q>
          </p>
          <RecordingView recording={recordingFor(RECORDINGS, FEATURED.slug, lang)} lang={lang} />
          <a className="aw-app-button aw-app-primary" href={`/agents/${FEATURED.slug}#try`}>
            {t('試してみる', 'Try it')}
          </a>
        </aside>
      </section>
      <Filters filter={filter} lang={lang} />
      {shelves.length === 0 ? (
        <p role="status">
          {t('条件に合うエージェントがありません。', 'No agent matches.')}{' '}
          {isFiltered(filter) ? <a href="/">{t('絞り込みを解除', 'Clear the filters')}</a> : null}
        </p>
      ) : (
        shelves.map(({ area, entries }) => (
          <section key={area.id} className="store-shelf" aria-labelledby={`shelf-${area.id}`}>
            <h2 id={`shelf-${area.id}`}>
              {pick(area.name, lang)}{' '}
              <small>{t(`${String(entries.length)}件`, `${String(entries.length)} agents`)}</small>
            </h2>
            <ul className="store-cards">
              {entries.map((entry) => (
                <Card key={entry.slug} entry={entry} lang={lang} maintenance={maintenance} />
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}
