import { STORE_PRIVACY_PATH, StorePrivacyFactsSchema } from '@indx-workspace/contracts/demo';
import { appRuntime } from '@indx-workspace/app/server';
import { cookies } from 'next/headers';

import { LANG_COOKIE, langOf } from '../lang';
import { demoHoursText, retentionText } from '../messages';
import { callPlatform } from '../platform-api';
import { tr } from '../text';

export const dynamic = 'force-dynamic';

/**
 * The privacy notice (R7). The period leads are kept and the demo workspace's lifetime are the
 * platform's configured facts, read here on the server, so the page never types them in. A provider
 * that is not chosen yet (email sender, lead CRM, challenge) is said to be to be decided.
 */
export default async function PrivacyPage() {
  const lang = langOf((await cookies()).get(LANG_COOKIE)?.value);
  const t = tr(lang);
  const answer = await callPlatform(
    appRuntime().awUrl,
    STORE_PRIVACY_PATH,
    StorePrivacyFactsSchema,
  );
  const facts = answer.ok ? answer.value : null;
  const toDecide = t('未定', 'to be decided');
  return (
    <main className="store-main">
      <h1>{t('プライバシー通知', 'Privacy notice')}</h1>
      <section aria-labelledby="collected">
        <h2 id="collected">{t('取得する情報', 'What we collect')}</h2>
        <ul>
          <li>
            {t(
              'メールアドレス（試す・相談・公開通知のとき）',
              'Your email address (when you try an agent, ask us something or ask for a launch notice)',
            )}
          </li>
          <li>{t('相談の内容と、選んだ設定', 'The message you write and the setup you chose')}</li>
          <li>
            {t(
              'デモ用ワークスペースで入力した内容と、エージェントの実行記録',
              'What you type in your demo workspace and the record of the agent’s runs',
            )}
          </li>
          <li>
            {t(
              'サインインの状態と言語設定を覚えるためのクッキー',
              'Cookies that remember your sign-in and your language',
            )}
          </li>
        </ul>
      </section>
      <section aria-labelledby="purpose">
        <h2 id="purpose">{t('利用目的', 'Why we use it')}</h2>
        <p>
          {t(
            'デモの提供、ご相談への返信、公開のお知らせ、不正利用の防止のためにだけ使います。',
            'Only to run the demo, answer your enquiry, tell you when an agent goes live, and prevent abuse.',
          )}
        </p>
      </section>
      <section aria-labelledby="processors">
        <h2 id="processors">{t('情報を扱う事業者', 'Who processes it')}</h2>
        <ul>
          <li>
            Google Cloud: {t('ストアとデモ環境の運用', 'hosts the store and the demo environment')}
          </li>
          <li>
            Anthropic:{' '}
            {t(
              'デモで入力したプロンプトは Anthropic の API に送られます',
              'the prompts you type in a demo go to Anthropic’s API',
            )}
          </li>
          <li>
            {t('メール送信事業者', 'Email sender')}: {toDecide}
          </li>
          <li>
            {t('見込み客の管理（CRM）', 'Lead CRM')}: {toDecide}
          </li>
          <li>
            {t('不正防止の確認（CAPTCHA）事業者', 'Challenge (CAPTCHA) provider')}: {toDecide}
          </li>
        </ul>
      </section>
      <section aria-labelledby="retention">
        <h2 id="retention">{t('保存期間', 'How long we keep it')}</h2>
        <ul>
          <li data-testid="lead-retention">
            {t('メールアドレスと相談の内容', 'Email address and enquiry')}:{' '}
            {retentionText(facts, lang)}
          </li>
          <li data-testid="demo-retention">
            {t(
              'デモ用ワークスペースと入力した内容は、作成から',
              'The demo workspace and what you typed are deleted ',
            )}
            {demoHoursText(facts, lang)}
            {t('後に削除されます。', ' after it is created.')}
          </li>
        </ul>
      </section>
      <section aria-labelledby="rights">
        <h2 id="rights">{t('削除・開示のご請求', 'Deletion and access')}</h2>
        <p>
          {t(
            '削除や開示をご希望の方は、',
            'To ask us to delete or show your data, write to us through the ',
          )}
          <a href="/contact">{t('相談フォーム', 'enquiry form')}</a>
          {t('からお知らせください。', '.')}
        </p>
      </section>
    </main>
  );
}
