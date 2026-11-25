/**
 * What the home page tells a first-time visitor before the shelves: the four steps from finding an
 * agent to running it in their own cloud, and the three things the store shows that no slide can
 * (what an agent does, that it is made to fit, how little code it is). Every number and name comes
 * from the catalog and the generated line counts.
 */
import { AREAS, CATALOG, COUNTS, CUSTOMIZE_CONTROLS } from '../catalog/index.ts';
import { LINE_COUNTS } from '../catalog/line-counts.generated.ts';
import { controlName } from './customize';
import { pick, type Lang } from './lang';
import { tr } from './text';

/** The live entries built as a whole app in `examples/<id>`, with their handwritten lines. */
function leanApps(lang: Lang) {
  return CATALOG.flatMap((entry) => {
    const lines =
      entry.status === 'live' ? LINE_COUNTS[entry.source.replace(/^examples\//u, '')] : undefined;
    return lines === undefined ? [] : [{ slug: entry.slug, name: pick(entry.name, lang), lines }];
  }).sort((a, b) => a.lines.handwritten - b.lines.handwritten);
}

export function Steps({ lang }: { readonly lang: Lang }) {
  const t = tr(lang);
  const steps = [
    {
      title: t('見つける', 'Find'),
      text: t(
        `${String(COUNTS.areas)}分野・${String(COUNTS.total)}のエージェントから、自分の仕事に合うものを選びます。`,
        `Pick the one that fits your work from ${String(COUNTS.total)} agents in ${String(COUNTS.areas)} areas.`,
      ),
    },
    {
      title: t('試す', 'Try'),
      text: t(
        'メールでサインインすると、あなた専用のデモ環境で、本物のエージェントがサンプルデータを使って動きます。',
        'Sign in by email and the real agent runs on sample data, in a demo workspace of your own.',
      ),
    },
    {
      title: t('自社向けに変える', 'Make it yours'),
      text: t(
        `${CUSTOMIZE_CONTROLS.map((control) => controlName(control, lang)).join('・')}を選ぶと、返答がその場で変わります。`,
        `Choose the ${CUSTOMIZE_CONTROLS.map((control) => controlName(control, lang).toLowerCase()).join(', ')} and watch the reply change.`,
      ),
    },
    {
      title: t('自社のクラウドに入れる', 'Install in your cloud'),
      text: t(
        'このストアと同じ構成で、あなたのクラウドに入れます。エージェントもデータも鍵も、自社の環境に置かれます。',
        'It installs into your cloud on the same stack as this store. The agent, the data and the keys stay with you.',
      ),
    },
  ];
  return (
    <section className="store-band" aria-labelledby="steps-title">
      <h2 id="steps-title">{t('使い方', 'How it works')}</h2>
      <ol className="store-steps">
        {steps.map((step) => (
          <li key={step.title}>
            <h3>{step.title}</h3>
            <p>{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Strengths({ lang }: { readonly lang: Lang }) {
  const t = tr(lang);
  const apps = leanApps(lang);
  return (
    <section className="store-band" aria-labelledby="strengths-title">
      <h2 id="strengths-title">{t('このストアで分かること', 'What this store shows')}</h2>
      <ul className="store-strengths">
        <li>
          <h3>{t('こんな仕事を任せられる', 'The work an agent can take on')}</h3>
          <p>
            {t(
              `${AREAS.map((area) => pick(area.name, lang)).join('、')}。うち${String(COUNTS.live)}のエージェントは、実際の Claude で検証したものをいま動かせます。`,
              `${AREAS.map((area) => pick(area.name, lang)).join(', ')}. ${String(COUNTS.live)} of them are verified with real Claude and run now.`,
            )}
          </p>
        </li>
        <li>
          <h3>{t('自社の環境に合わせて変えられる', 'Made to fit your company')}</h3>
          <p>
            {t(
              'エージェントは頼んだ人の権限の範囲でだけ動き、書き込みは人の承認を待てます。つなぐシステムも、口調も、承認の決まりも、自社に合わせて選べます。',
              'An agent acts only within the asking person’s access, and its writes can wait for a person’s approval. The systems it connects to, its tone and its approval rules are yours to choose.',
            )}
          </p>
        </li>
        <li>
          <h3>{t('少ないコードで作れる', 'Very little code')}</h3>
          <p>
            {t(
              'エージェントは数十〜数百行の設定ファイルです。残りは SDK が生成し、ソースはすべて GitHub で読めます。',
              'An agent is a definition of tens to hundreds of lines. The SDK generates the rest, and every source is on GitHub.',
            )}
          </p>
          {apps.length > 0 ? (
            <ul className="store-lines" aria-label={t('手書きの行数', 'Handwritten lines')}>
              {apps.map(({ slug, name, lines }) => (
                <li key={slug}>
                  <a href={`/agents/${slug}#code`}>{name}</a>
                  <meter min={0} max={lines.budget} value={lines.handwritten} aria-label={name} />
                  <span>
                    {t(`${String(lines.handwritten)}行`, `${String(lines.handwritten)} lines`)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      </ul>
    </section>
  );
}
