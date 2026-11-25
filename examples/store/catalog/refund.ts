import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'refund',
  area: 'support',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/refund',
  name: {
    ja: '返金審査',
    en: 'Refund review',
  },
  summary: {
    ja: '返金申請を規程と照らし、承認者に判断材料をまとめて渡す。',
    en: 'Checks refund requests against policy and hands the approver a summary.',
  },
  demo: {
    agent: 'refund',
    prompts: [
      {
        ja: 'refund/inbox/RQ-2611-018_返金申請.md を返金規程に照らして確認して',
        en: 'Check refund/inbox/RQ-2611-018_返金申請.md against the refund policy',
      },
      {
        ja: 'refund/inbox/RQ-2611-018_返金申請.md の申請金額が請求データと合っているか、RF-04 だけ確かめて',
        en: 'Check only RF-04: does the amount in refund/inbox/RQ-2611-018_返金申請.md match the billing record?',
      },
    ],
    moment: {
      ja: '返金の申請を渡すと、規程の項目ごとに判定と確認点が並び、判断材料の保存は承認を待つ。返金はしない。',
      en: 'Hand over a refund request; each policy item gets a verdict and what to confirm, saving waits for approval, and no refund is made.',
    },
    data: {
      ja: '架空の返金申請・請求データ・返金規程',
      en: 'fictional refund requests, billing records and a refund policy',
    },
    seed: [{ collection: 'refund', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'Write' },
  },
  safety: ['person', 'approval', 'files'],
});
