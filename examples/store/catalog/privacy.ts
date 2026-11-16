import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'privacy',
  area: 'legal',
  status: 'soon',
  wave: 2,
  name: {
    ja: '個人情報影響評価',
    en: 'Privacy impact',
  },
  summary: {
    ja: '新サービスの個人データの扱いを質問形式で整理し、評価表を作る。',
    en: "Walks through a new service's personal data use and builds the assessment.",
  },
});
