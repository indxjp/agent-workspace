import { cookies } from 'next/headers';

import { CLAIMS, plannedMarker } from '../claims';
import { LANG_COOKIE, langOf, pick } from '../lang';
import { tr } from '../text';

export const dynamic = 'force-dynamic';

/** Safety and the platform, on one page: what holds today and what is still planned. */
export default async function PlatformPage() {
  const lang = langOf((await cookies()).get(LANG_COOKIE)?.value);
  const t = tr(lang);
  return (
    <main className="store-main">
      <h1>{t('安全性と仕組み', 'Safety and platform')}</h1>
      <p>
        {t(
          'このストアのエージェントは、Agent Workspace の上で動きます。確認できていることと、まだ確認できていないことを分けて書きます。',
          'The agents in this store run on Agent Workspace. This page keeps what holds today apart from what is still planned.',
        )}
      </p>
      <section aria-labelledby="safety-title">
        <h2 id="safety-title">{t('安全', 'Safety')}</h2>
        <ul>
          {CLAIMS.map((claim) => (
            <li key={claim.id} data-claim={claim.id}>
              {pick(claim.text, lang)}{' '}
              {claim.status.kind === 'planned' ? (
                <span className="aw-app-badge">{plannedMarker(claim.status.phase, lang)}</span>
              ) : (
                <small>
                  {t('根拠: ', 'Evidence: ')}
                  {claim.status.evidence.map((file) => (
                    <code key={file}> {file}</code>
                  ))}
                </small>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="models-title">
        <h2 id="models-title">{t('プロンプトの送り先', 'Where prompts go')}</h2>
        <p>
          {t(
            'このサイトのデモでは、入力したプロンプトは Anthropic の API に送られます。',
            'On this site, the demos send the prompts you type to Anthropic’s API.',
          )}
        </p>
        <p>
          {t(
            '導入した会社は、Vertex AI 上の Claude を選べば、プロンプトを自社の Google Cloud の中に留められます。',
            'A company that installs an agent can keep its prompts inside its own Google Cloud by choosing Claude on Vertex AI.',
          )}
        </p>
      </section>
      <p>
        <a href="/privacy">{t('プライバシー通知', 'Privacy notice')}</a>
      </p>
    </main>
  );
}
