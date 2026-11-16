import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'supplier',
  area: 'mfg',
  status: 'soon',
  wave: 2,
  name: {
    ja: '仕入先品質管理',
    en: 'Supplier quality',
  },
  summary: {
    ja: '受入検査とクレームの履歴から、仕入先ごとの品質の傾向を報告する。',
    en: 'Reports quality trends per supplier from inspections and claims.',
  },
});
