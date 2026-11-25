import { LINE_COUNTS } from '../../../catalog/line-counts.generated.ts';
import { PUBLIC_REPOSITORY_URL, type LiveEntry } from '../../../catalog/index.ts';
import { SOURCES } from '../../../catalog/sources.generated.ts';
import { featureNames } from '../../labels';
import type { Lang } from '../../lang';
import { tr } from '../../text';

/** The section for engineers: real source, its layout, handwritten lines and the features used. */
export function UnderTheHood({ entry, lang }: { readonly entry: LiveEntry; readonly lang: Lang }) {
  const t = tr(lang);
  const view = SOURCES[entry.slug];
  const lines = LINE_COUNTS[entry.source.replace(/^examples\//u, '')];
  return (
    <div className="store-under-the-hood">
      <p>
        <a href={`${PUBLIC_REPOSITORY_URL}/tree/main/${entry.source}`}>
          {t('GitHub でソースを見る', 'View source on GitHub')}
        </a>
      </p>
      {lines === undefined ? null : (
        <section aria-labelledby="lines-title">
          <h3 id="lines-title">{t('手書きのコード', 'Handwritten code')}</h3>
          <p>
            {t(
              `${String(lines.handwritten)}行（上限 ${String(lines.budget)}行）。残りは SDK が生成します。`,
              `${String(lines.handwritten)} lines of a ${String(lines.budget)}-line budget. The SDK generates the rest.`,
            )}
          </p>
          <progress
            className="store-bar"
            value={lines.handwritten}
            max={lines.budget}
            aria-label={t('手書きの行数と上限', 'Handwritten lines against the budget')}
          />
        </section>
      )}
      <section aria-labelledby="features-title">
        <h3 id="features-title">{t('使っている機能', 'Features used')}</h3>
        <ul>
          {featureNames(entry.safety, lang).map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
      </section>
      {view === undefined ? null : (
        <>
          <section aria-labelledby="source-title">
            <h3 id="source-title">{t('実際のソース', 'The real source')}</h3>
            <p>
              <code>{view.agentFile}</code>
              {view.truncated ? t('（冒頭のみ）', ' (first lines only)') : null}
            </p>
            <pre className="store-code" tabIndex={0} aria-label={view.agentFile}>
              <code>{view.excerpt}</code>
            </pre>
          </section>
          <section aria-labelledby="layout-title">
            <h3 id="layout-title">{t('ファイル構成', 'File layout')}</h3>
            <pre className="store-code" tabIndex={0} aria-label={t('ファイル構成', 'File layout')}>
              <code>{view.layout.join('\n')}</code>
            </pre>
          </section>
        </>
      )}
    </div>
  );
}
