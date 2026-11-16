import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'expense',
  area: 'finance',
  status: 'soon',
  wave: 2,
  name: {
    ja: '経費精算チェック',
    en: 'Expense audit',
  },
  summary: {
    ja: '領収書と申請内容の食い違いや規程違反を見つける。',
    en: 'Finds mismatches between receipts and claims, and policy breaches.',
  },
});
