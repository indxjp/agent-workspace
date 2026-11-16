import { appRuntime } from '@indx-workspace/app/server';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import { CATALOG, entryView, type CatalogEntry } from '../../../catalog/index.ts';
import { RECORDINGS } from '../../../catalog/recordings.generated.ts';
import { areaName, safetyTags } from '../../labels';
import { LANG_COOKIE, langOf, pick, type Lang } from '../../lang';
import { LeadForm } from '../../lead-form';
import { tr } from '../../text';
import { maintenanceSlugs, tryChoice, verificationLabel } from '../../verification';
import { CustomizePreview } from './customize-preview';
import { Tabs, type TabSpec } from './tabs';
import { Fallback } from './try/fallback';
import { TryTab } from './try/try-tab';
import { UnderTheHood } from './under-the-hood';

export const dynamic = 'force-dynamic';

/** What it does, who it is for, how it works, what it connects to and the safety tags that hold. */
function Overview({ entry, lang }: { readonly entry: CatalogEntry; readonly lang: Lang }) {
  const t = tr(lang);
  const view = entryView(entry);
  const steps = [
    t('受け取る：依頼を受ける', 'Receive: takes the request'),
    t(
      `調べる：${pick(view.flow, lang).join('、')}`,
      `Look up: ${pick(view.flow, lang).join(', ')}`,
    ),
    t('判断する：根拠を添えて案を作る', 'Decide: drafts an answer with its reasons'),
    t('人が確認する：書き込みは承認を待てる', 'A person confirms: writes can wait for approval'),
    t('書き込む：確認された内容だけ', 'Write: only what was confirmed'),
  ];
  const tags = safetyTags(entry, lang);
  return (
    <div>
      <p>{pick(entry.summary, lang)}</p>
      <h3>{t('誰向けか', 'Who it is for')}</h3>
      <p>{t(`${areaName(entry, lang)}の担当者`, `People working in ${areaName(entry, lang)}`)}</p>
      <h3>{t('処理の流れ', 'How it works')}</h3>
      <ol>
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <h3>{t('つなぐシステム', 'Systems it connects to')}</h3>
      <ul className="aw-app-chips">
        {view.connects.map((system) => (
          <li key={system} className="aw-app-chip">
            {system}
          </li>
        ))}
      </ul>
      {tags.length === 0 ? null : (
        <>
          <h3>{t('安全のために', 'Safety')}</h3>
          <ul aria-label={t('安全機能', 'Safety features')}>
            {tags.map((tag) => (
              <li key={tag} className="aw-app-badge">
                {tag}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export default async function AgentPage({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entry = CATALOG.find((candidate) => candidate.slug === slug);
  if (entry === undefined) notFound();
  const lang = langOf((await cookies()).get(LANG_COOKIE)?.value);
  const t = tr(lang);
  const platformUrl = appRuntime().awUrl;
  const maintenance = entry.status === 'live' ? await maintenanceSlugs(platformUrl) : [];
  const tried = tryChoice(entry.slug, maintenance, RECORDINGS, lang);
  const overview = <Overview entry={entry} lang={lang} />;
  const tabs: TabSpec[] =
    entry.status === 'live'
      ? [
          { id: 'overview', label: t('概要', 'Overview'), panel: overview },
          {
            id: 'try',
            label: t('試す', 'Try it'),
            panel:
              tried.kind === 'unavailable' ? (
                <Fallback reason="unavailable" lang={lang} recording={tried.recording} />
              ) : (
                <TryTab entry={entry} lang={lang} platformUrl={platformUrl} />
              ),
          },
          {
            id: 'customize',
            label: t('導入とカスタマイズ', 'Install & customize'),
            panel: <CustomizePreview entry={entry} lang={lang} />,
          },
          {
            id: 'code',
            label: t('仕組み', 'Under the hood'),
            panel: <UnderTheHood entry={entry} lang={lang} />,
          },
        ]
      : [
          { id: 'overview', label: t('概要', 'Overview'), panel: overview },
          {
            id: 'soon',
            label: t('近日公開', 'Coming soon'),
            panel: (
              <section aria-labelledby="soon-title">
                <h3 id="soon-title">{t('公開をお知らせします', 'Get a launch notice')}</h3>
                <p>
                  {t(
                    'このエージェントはまだ公開前です。公開したときにメールでお知らせします。',
                    'This agent is not live yet. We will email you when it opens.',
                  )}
                </p>
                <LeadForm
                  kind="launch_notice"
                  lang={lang}
                  platformUrl={platformUrl}
                  entry={entry.slug}
                />
              </section>
            ),
          },
        ];
  return (
    <main className="store-main">
      <p>
        <a href={`/?cat=${entry.area}`}>{areaName(entry, lang)}</a>
      </p>
      <h1>{pick(entry.name, lang)}</h1>
      <span className="aw-app-badge">
        {entry.status === 'live' ? t('今すぐ試せる', 'Try now') : t('近日公開', 'Coming soon')}
      </span>
      {entry.status === 'live' ? (
        <span className="aw-app-badge">{verificationLabel(entry.slug, lang, maintenance)}</span>
      ) : null}
      <Tabs tabs={tabs} label={t('エージェントの情報', 'About this agent')} />
    </main>
  );
}
