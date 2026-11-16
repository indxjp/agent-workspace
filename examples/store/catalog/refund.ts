import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'refund',
  area: 'support',
  status: 'soon',
  wave: 3,
  name: {
    ja: '返金審査',
    en: 'Refund review',
  },
  summary: {
    ja: '返金申請を規程と照らし、承認者に判断材料をまとめて渡す。',
    en: 'Checks refund requests against policy and hands the approver a summary.',
  },
});
