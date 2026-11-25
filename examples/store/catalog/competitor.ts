import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'competitor',
  area: 'sales',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/competitor',
  name: {
    ja: '競合比較シート',
    en: 'Competitor brief',
  },
  summary: {
    ja: '公開情報から競合製品の比較表を最新に保つ。',
    en: 'Keeps a competitor comparison table current from public sources.',
  },
  demo: {
    agent: 'competitor',
    prompts: [
      {
        ja: '2026-11-23 時点の競合比較レポートを作成して',
        en: 'Write the competitor comparison report as of 2026-11-23',
      },
      {
        ja: 'ツユクサ・ラボに絞って、2026-11-23 時点の競合比較レポートを作成して',
        en: 'Write the competitor comparison report as of 2026-11-23 for Tsuyukusa Labs only',
      },
    ],
    moment: {
      ja: '比較表のうち競合の発表で変わった行が、変更前と変更後・根拠の発表と公開情報の時点つきで並び、保存は承認を待つ。',
      en: "The table's rows that competitors' releases changed are listed with the value before and after, the release and the date of the public sources; the save waits for approval.",
    },
    data: {
      ja: '架空の競合各社の発表の日付つきスナップショットと、営業チームの比較表',
      en: "a dated snapshot of fictional competitors' releases, and the sales team's comparison table",
    },
    seed: [{ collection: 'competitor', from: 'data/ja' }],
    check: { tools: ['read_competitor_news'], approval: 'Write' },
  },
  safety: ['approval', 'trigger', 'structured', 'files'],
});
