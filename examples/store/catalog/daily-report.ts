import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'daily-report',
  area: 'mfg',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/daily-report',
  name: {
    ja: '生産日報まとめ',
    en: 'Production daily',
  },
  summary: {
    ja: '各ラインの日報から稼働率と課題をまとめる。',
    en: 'Rolls up line reports into utilization and issues.',
  },
  demo: {
    agent: 'daily-report',
    prompts: [
      {
        ja: '2026-11-24 の生産日報まとめを作成して',
        en: 'Write the production daily for 2026-11-24',
      },
      {
        ja: '2026-11-25 の生産日報まとめを作成して',
        en: 'Write the production daily for 2026-11-25',
      },
    ],
    moment: {
      ja: 'ラインごとの稼働率・生産数・不良数と止まった理由が、日報の数字のまま並び、保存は承認を待つ。',
      en: 'Each line’s utilization, output and defects appear as the line reports give them, with the reason for each stop; the save waits for approval.',
    },
    data: {
      ja: '架空の生産管理システムのライン日報',
      en: 'a fictional MES line report export',
    },
    seed: [{ collection: 'daily-report', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'Write' },
  },
  safety: ['approval', 'trigger', 'structured', 'files'],
});
