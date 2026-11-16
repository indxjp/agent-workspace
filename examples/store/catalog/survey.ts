import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'survey',
  area: 'support',
  status: 'soon',
  wave: 3,
  name: {
    ja: 'アンケート集計',
    en: 'Survey analyst',
  },
  summary: {
    ja: '自由記述を含むアンケートを集計し、要点をグラフ付きで報告する。',
    en: 'Tallies surveys, free text included, and reports the key points with charts.',
  },
});
