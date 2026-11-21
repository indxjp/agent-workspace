import { appRuntime } from '@indx-workspace/app/server';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { CATALOG, entryView } from '../../../catalog/index.ts';
import { LANDING } from '../../../catalog/landing.generated.ts';
import { RECORDINGS } from '../../../catalog/recordings.generated.ts';
import { areaName, featureNames, safetyTags } from '../../labels';
import { LANG_COOKIE, langOf, pick } from '../../lang';
import { LeadForm } from '../../lead-form';
import { entryJsonLd, entryMetadata } from '../../seo';
import { SHOTS } from '../../shots.generated';
import { tr } from '../../text';
import { maintenanceSlugs, tryChoice, verificationLabel } from '../../verification';
import { CustomizePreview } from './customize-preview';
import { Fallback } from './try/fallback';
import { TryTab } from './try/try-tab';
import { UnderTheHood } from './under-the-hood';

export const dynamic = 'force-dynamic';

type Params = { readonly params: Promise<{ slug: string }> };

/** The page's title, description, canonical and `hreflang` URLs and social card (plan §6.3). */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const entry = CATALOG.find((candidate) => candidate.slug === slug);
  const lang = langOf((await cookies()).get(LANG_COOKIE)?.value);
  return entry === undefined ? {} : entryMetadata(entry, lang);
}

/** One section of the page, reachable at `#<id>` (`#try`, `#customize`, `#code`, `#notify`). */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{title}</h2>
      {children}
    </section>
  );
}

const list = (items: readonly string[]) => (
  <ul>
    {items.map((item) => (
      <li key={item}>{item}</li>
    ))}
  </ul>
);

/**
 * An entry's landing page (use-cases plan §6.2), one scrolling page for live and coming-soon entries:
 * each section shows when the entry has what it needs (its landing copy, a demo, a source).
 */
export default async function AgentPage({ params }: Params) {
  const { slug } = await params;
  const entry = CATALOG.find((candidate) => candidate.slug === slug);
  if (entry === undefined) notFound();
  const lang = langOf((await cookies()).get(LANG_COOKIE)?.value);
  const t = tr(lang);
  const name = pick(entry.name, lang);
  const live = entry.status === 'live';
  const copy = LANDING[entry.slug];
  const platformUrl = appRuntime().awUrl;
  const maintenance = live ? await maintenanceSlugs(platformUrl) : [];
  const tried = tryChoice(entry.slug, maintenance, RECORDINGS, lang);
  const view = entryView(entry);
  const tags = safetyTags(entry, lang);
  const related = CATALOG.filter((other) => other.area === entry.area && other !== entry);
  return (
    <main className="store-main">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: entryJsonLd(entry, lang) }}
      />
      <p>
        <a href={`/?cat=${entry.area}`}>{areaName(entry, lang)}</a>
      </p>
      <h1>{name}</h1>
      <span className="aw-app-badge">
        {live ? t('今すぐ試せる', 'Try now') : t('近日公開', 'Coming soon')}
      </span>
      {live ? (
        <span className="aw-app-badge">{verificationLabel(entry.slug, lang, maintenance)}</span>
      ) : null}
      <p>{pick(copy?.headline ?? entry.summary, lang)}</p>
      <p>
        {t('誰向けか：', 'Who it is for: ')}
        {copy
          ? pick(copy.audience, lang)
          : t(`${areaName(entry, lang)}の担当者`, `people working in ${areaName(entry, lang)}`)}
      </p>
      <a className="aw-app-button aw-app-primary" href={live ? '#try' : '#notify'}>
        {live ? t('試す', 'Try it') : t('公開の通知を受け取る', 'Get a launch notice')}
      </a>
      {tags.length > 0 ? (
        <ul aria-label={t('安全機能', 'Safety features')}>
          {tags.map((tag) => (
            <li key={tag} className="aw-app-badge">
              {tag}
            </li>
          ))}
        </ul>
      ) : null}
      {copy ? (
        <Section id="problem" title={t('いまの課題', 'The problem')}>
          <p>{pick(copy.problem, lang)}</p>
        </Section>
      ) : null}
      <Section id="how" title={t('処理の流れ', 'How it works')}>
        {copy ? (
          <ol>
            {copy.steps.map((step) => (
              <li key={step.text.en}>
                {pick(step.text, lang)}
                {step.safety.length > 0
                  ? t(
                      `（${featureNames(step.safety, lang).join('・')}）`,
                      ` (${featureNames(step.safety, lang).join(', ')})`,
                    )
                  : null}
              </li>
            ))}
          </ol>
        ) : (
          <p>
            {t(
              `調べるもの：${pick(view.flow, lang).join('、')}`,
              `What it looks up: ${pick(view.flow, lang).join(', ')}`,
            )}
          </p>
        )}
        <p>
          {t(
            `つなぐシステム：${view.connects.join('、')}`,
            `Systems it connects to: ${view.connects.join(', ')}`,
          )}
        </p>
      </Section>
      {copy ? (
        <Section id="outputs" title={t('得られるもの', 'What you get')}>
          {list(copy.outputs.map((output) => pick(output, lang)))}
          {live ? (
            <img
              src={`/shots/${entry.slug}.${lang}.webp`}
              alt={t(`${name}のデモの結果`, `The result of the ${name} demo`)}
              {...SHOTS[`${entry.slug}.${lang}`]}
            />
          ) : null}
        </Section>
      ) : null}
      {entry.status === 'live' ? (
        <>
          <Section id="try" title={t('試す', 'Try it')}>
            {tried.kind === 'unavailable' ? (
              <Fallback reason="unavailable" lang={lang} recording={tried.recording} />
            ) : (
              <TryTab entry={entry} lang={lang} platformUrl={platformUrl} />
            )}
          </Section>
          <Section id="customize" title={t('導入とカスタマイズ', 'Install & customize')}>
            <CustomizePreview entry={entry} lang={lang} />
          </Section>
          <Section id="code" title={t('仕組み', 'Under the hood')}>
            <UnderTheHood entry={entry} lang={lang} />
          </Section>
        </>
      ) : (
        <Section id="notify" title={t('公開の通知を受け取る', 'Get a launch notice')}>
          <p>
            {t(
              'このエージェントはまだ公開前です。公開したときにメールでお知らせします。',
              'This agent is not live yet. We will email you when it opens.',
            )}
          </p>
          <LeadForm kind="launch_notice" lang={lang} platformUrl={platformUrl} entry={entry.slug} />
        </Section>
      )}
      {copy ? (
        <>
          <Section id="faq" title={t('よくある質問', 'FAQ')}>
            <dl>
              {copy.faq.map(({ q, a }) => (
                <div key={q.en}>
                  <dt>{pick(q, lang)}</dt>
                  <dd>{pick(a, lang)}</dd>
                </div>
              ))}
            </dl>
          </Section>
          <Section id="limits" title={t('しないこと', 'Limits')}>
            {list(copy.limits.map((limit) => pick(limit, lang)))}
          </Section>
        </>
      ) : null}
      {related.length > 0 ? (
        <Section id="related" title={t('同じ分野のエージェント', 'Related agents')}>
          <ul>
            {related.map((other) => (
              <li key={other.slug}>
                <a href={`/agents/${other.slug}`}>{pick(other.name, lang)}</a>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </main>
  );
}
