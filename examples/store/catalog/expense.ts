import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'expense',
  area: 'finance',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/expense',
  name: {
    ja: '経費精算チェック',
    en: 'Expense audit',
  },
  summary: {
    ja: '領収書と申請内容の食い違いや規程違反を見つける。',
    en: 'Finds mismatches between receipts and claims, and policy breaches.',
  },
  demo: {
    agent: 'expense',
    prompts: [
      {
        ja: 'expense/inbox/経費精算_EX-2611-0042_渡瀬ハルキ.csv をチェックして',
        en: 'Check expense/inbox/経費精算_EX-2611-0042_渡瀬ハルキ.csv',
      },
      {
        ja: 'EXP-03 のタクシーの規程を説明して',
        en: 'Explain the EXP-03 taxi policy.',
      },
    ],
    moment: {
      ja: '経費精算の申請を指定すると、明細ごとに規程違反と領収書の食い違いが「OK・要注意・NG」で並び、保存は承認を待つ。',
      en: 'Name an expense claim; each line is marked OK, caution or NG for policy breaches and receipt mismatches, and saving waits for approval.',
    },
    data: {
      ja: '架空の経費精算の申請CSV・旅費・経費規程',
      en: 'fictional expense claim CSVs, a travel and expense policy',
    },
    seed: [{ collection: 'expense', from: 'data/ja' }],
    check: { tools: ['Read'], approval: 'Write' },
  },
  safety: ['approval', 'files', 'structured'],
});
