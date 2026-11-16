import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'newcomer',
  area: 'knowledge',
  status: 'soon',
  wave: 2,
  name: {
    ja: '新人ガイド',
    en: 'New-joiner guide',
  },
  summary: {
    ja: '部署の資料から、新人向けの最初の2週間の案内を作る。',
    en: 'Builds a first-two-weeks guide for new joiners from team documents.',
  },
});
