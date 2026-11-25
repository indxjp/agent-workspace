import type { Lang } from '../../lang';
import { tr } from '../../text';

/**
 * How an entry gets from this page into a company, above its customize controls. A customer is
 * never shown a command (spec 03): they see what happens at each step and who does it.
 */
export function InstallSteps({ lang }: { readonly lang: Lang }) {
  const t = tr(lang);
  const steps = [
    {
      title: t('設定を選ぶ', 'Choose the setup'),
      text: t(
        '下で会社名や承認の決まりを選ぶと、エージェントの返答がその場で変わります。',
        'Pick your company name, approval rule and the rest below, and the reply changes as you do.',
      ),
    },
    {
      title: t('その設定で相談する', 'Send it to us'),
      text: t(
        '選んだ設定は相談フォームにそのまま入ります。導入先のクラウドとつなぐシステムを一緒に決めます。',
        'The setup you chose goes into the enquiry as it is. We agree on the cloud and the systems together.',
      ),
    },
    {
      title: t('自社のクラウドに入れる', 'Install it in your cloud'),
      text: t(
        'このストアと同じ構成で、あなたのクラウドに入れます。エージェントもデータも鍵も、自社の環境に置かれます。',
        'It goes into your cloud on the same stack as this store. The agent, the data and the keys stay with you.',
      ),
    },
    {
      title: t('社内のデータで動かす', 'Run it on your data'),
      text: t(
        'サンプルの代わりに自社のファイルやシステムにつなぎます。社員は自分の権限の範囲で使えます。',
        'It connects to your own files and systems in place of the samples, and each person uses it within their own access.',
      ),
    },
  ];
  return (
    <section aria-labelledby="install-title">
      <h3 id="install-title">{t('導入までの流れ', 'From here to your company')}</h3>
      <ol className="store-steps store-steps-compact">
        {steps.map((step) => (
          <li key={step.title}>
            <h4>{step.title}</h4>
            <p>{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
