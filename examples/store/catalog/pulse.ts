import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'pulse',
  area: 'hr',
  status: 'soon',
  wave: 3,
  name: {
    ja: '社員サーベイ分析',
    en: 'Engagement survey',
  },
  summary: {
    ja: 'サーベイの結果を部署別に分析し、打ち手の案を作る。',
    en: 'Analyses survey results by team and proposes actions.',
  },
});
