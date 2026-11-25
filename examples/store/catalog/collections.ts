import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'collections',
  area: 'finance',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/collections',
  name: {
    ja: '売掛金回収',
    en: 'Collections assistant',
  },
  summary: {
    ja: '入金の遅れている取引先を拾い、督促メールの下書きを作る。',
    en: 'Finds late payers and drafts reminder emails.',
  },
  demo: {
    agent: 'collections',
    prompts: [
      {
        ja: '2026-11-24 時点の督促リストを作成して',
        en: 'Write the collections list as of 2026-11-24',
      },
      {
        ja: '株式会社シラサギ工業の未入金に絞って、2026-11-24 時点の督促リストを作成して',
        en: 'Write the collections list as of 2026-11-24 for Shirasagi Industries only',
      },
    ],
    moment: {
      ja: '入金の遅れている請求が、遅延日数と督促の段階、督促メールの下書きつきで並び、保存は承認を待つ。メールは送らない。',
      en: 'Late invoices are listed with the days overdue, the reminder stage and a draft reminder email; the save waits for approval, and no email is sent.',
    },
    data: {
      ja: '架空の会計システムの売掛金明細',
      en: 'a fictional accounts receivable export',
    },
    seed: [{ collection: 'collections', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'Write' },
  },
  safety: ['approval', 'trigger', 'structured', 'files'],
});
