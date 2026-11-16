import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'churn',
  area: 'analytics',
  status: 'soon',
  wave: 3,
  name: {
    ja: '解約予兆分析',
    en: 'Churn signals',
  },
  summary: {
    ja: '利用状況から解約しそうな顧客を見つけ、理由を推定する。',
    en: 'Finds customers likely to leave and the probable reasons.',
  },
});
