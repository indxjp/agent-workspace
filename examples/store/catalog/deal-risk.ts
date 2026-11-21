import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'deal-risk',
  area: 'sales',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/deal-risk',
  name: {
    ja: '失注リスク検知',
    en: 'Deal risk monitor',
  },
  summary: {
    ja: '動きの止まった商談とリスクのある商談を、根拠と次の一手つきで一覧にする。',
    en: 'Lists stalled and at-risk deals with the evidence and a next step.',
  },
  demo: {
    agent: 'deal-risk',
    prompts: [
      {
        ja: '2026-11-24 時点の失注リスクレポートを作成して',
        en: 'Write the deal risk report as of 2026-11-24',
      },
      {
        ja: '樋渡さんの担当案件に絞って、2026-11-24 時点の失注リスクレポートを作成して',
        en: 'Write the deal risk report as of 2026-11-24 for Hina Hiwatari’s deals only',
      },
    ],
    moment: {
      ja: '止まっている商談とリスクの兆しがある商談が、根拠と次の一手つきで並び、保存は承認を待つ。',
      en: 'Stalled and at-risk deals are listed with the evidence and a next step; the save waits for approval.',
    },
    data: {
      ja: '架空のCRMの案件一覧と活動記録',
      en: 'a fictional CRM deal list and activity log',
    },
    seed: [{ collection: 'deal-risk', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'Write' },
  },
  safety: ['approval', 'trigger', 'structured', 'files'],
});
