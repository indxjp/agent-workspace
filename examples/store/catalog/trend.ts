import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'trend',
  area: 'analytics',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/trend',
  name: {
    ja: 'トレンドウォッチ',
    en: 'Trend watch',
  },
  summary: {
    ja: 'ニュースと公開投稿から自社に関係する話題を毎朝まとめる。',
    en: "Writes up the morning's relevant news and public posts.",
  },
  demo: {
    agent: 'trend',
    prompts: [
      {
        ja: '2026-11-21 のトレンドダイジェストを作成して',
        en: 'Write the trend digest for 2026-11-21',
      },
      {
        ja: '2026-11-19 のトレンドダイジェストを作成して',
        en: 'Write the trend digest for 2026-11-19',
      },
    ],
    moment: {
      ja: '追いかけているトピックごとに、その日と前日のニュースと公開投稿が出典と公開情報の時点つきで並び、保存は承認を待つ。',
      en: 'The news and public posts of the day and the day before are listed under each topic you follow, with the source and the date of the public sources; the save waits for approval.',
    },
    data: {
      ja: '架空のニュース記事と公開投稿の日付つきスナップショットと、社内のトピック一覧',
      en: 'a dated snapshot of fictional news articles and public posts, and an internal topic list',
    },
    seed: [{ collection: 'trend', from: 'data/ja' }],
    check: { tools: ['read_public_news'], approval: 'Write' },
  },
  safety: ['approval', 'trigger', 'structured', 'files'],
});
