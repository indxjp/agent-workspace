import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'proposal',
  area: 'sales',
  status: 'soon',
  wave: 2,
  name: {
    ja: '提案書ドラフト',
    en: 'Proposal drafter',
  },
  summary: {
    ja: 'ヒアリングメモから、課題・解決策・費用の骨子とスライド構成を作る。',
    en: 'Turns discovery notes into an outline: problem, solution, cost, and a slide plan.',
  },
});
