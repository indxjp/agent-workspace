import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'budget',
  area: 'finance',
  status: 'soon',
  wave: 2,
  name: {
    ja: '予実差異分析',
    en: 'Budget variance',
  },
  summary: {
    ja: '予算と実績の差を要因別に分け、コメント案を作る。',
    en: 'Breaks budget-versus-actual gaps into drivers and drafts commentary.',
  },
});
