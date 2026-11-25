import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'pulse',
  title: '社員サーベイ分析 / Engagement survey',
  layout: 'page',
  parts: {
    attachments: true,
    greeting: '分析するサーベイのCSVを指定してください。 / Name the survey CSV to analyse.',
    suggestedPrompts: [
      '社員サーベイ_2026年11月.csv を部署別に分析して、打ち手の案を出して',
      'Analyse engagement-survey-2026-11.csv by team and suggest actions',
      '社員サーベイ_2026年11月.csv を 社員サーベイ_2026年5月.csv と比べて、下がった項目を挙げて',
      'Compare engagement-survey-2026-11.csv with engagement-survey-2026-05.csv and list what dropped',
    ],
    disclaimer:
      '部署単位の集計です。打ち手は担当者が決めます。 / Team level only; a person decides.',
    toolTrace: 'collapsed',
    history: true,
  },
  // The typed output's rows, drawn under the answer (ADR-0168): field, row label and row value.
  resultCharts: [
    {
      kind: 'bar',
      field: 'teams',
      label: 'team',
      value: 'favourable',
      title: { ja: '部署別の好意的な回答の割合（%）', en: 'Favourable answers by team (%)' },
      axes: { label: { ja: '部署', en: 'Team' }, value: { ja: '割合', en: 'Share' } },
    },
    {
      kind: 'bar',
      field: 'questions',
      label: 'question',
      value: 'favourable',
      title: { ja: '設問別の好意的な回答の割合（%）', en: 'Favourable answers by question (%)' },
      axes: { label: { ja: '設問', en: 'Question' }, value: { ja: '割合', en: 'Share' } },
    },
  ],
});
