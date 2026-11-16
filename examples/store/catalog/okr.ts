import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'okr',
  area: 'collab',
  status: 'soon',
  wave: 2,
  name: {
    ja: 'OKR進捗',
    en: 'OKR tracker',
  },
  summary: {
    ja: '各チームの数字を集め、目標に対する進み具合を報告する。',
    en: 'Collects team numbers and reports progress against goals.',
  },
});
