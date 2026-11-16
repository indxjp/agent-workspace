import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'tax',
  area: 'finance',
  status: 'soon',
  wave: 3,
  name: {
    ja: '税務チェック',
    en: 'Tax check',
  },
  summary: {
    ja: '取引の消費税区分やインボイスの要件を確認する。',
    en: 'Checks consumption-tax categories and invoice requirements.',
  },
});
