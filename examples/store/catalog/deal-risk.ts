import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'deal-risk',
  area: 'sales',
  status: 'soon',
  wave: 2,
  name: {
    ja: '失注リスク検知',
    en: 'Deal risk monitor',
  },
  summary: {
    ja: '動きの止まった商談を見つけ、次の一手を担当者に提案する。',
    en: 'Finds stalled deals and suggests the next step to the owner.',
  },
});
