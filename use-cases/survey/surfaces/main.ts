import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'survey',
  title: 'アンケート集計 / Survey analyst',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '集計するアンケートのCSVと月を指定してください。 / Name the survey CSV and the month.',
    suggestedPrompts: [
      'アンケート回答_2026年10月-11月.csv で2026年11月の回答を集計して',
      'Tally the November 2026 responses in survey-responses-2026-10-to-11.csv',
      'アンケート回答_2026年10月-11月.csv で2026年10月の満足度を窓口別に比べて',
      'Compare satisfaction by channel for October 2026 in survey-responses-2026-10-to-11.csv',
    ],
    disclaimer: '数値はスクリプトの集計結果です。判断は担当者が行います。 / A person decides.',
    toolTrace: 'collapsed',
    history: true,
  },
  // The typed output's rows, drawn under the answer (ADR-0168): field, row label and row value.
  resultCharts: [
    {
      kind: 'bar',
      field: 'questions',
      label: 'question',
      value: 'favourable',
      title: { ja: '設問別の好意的な回答の割合（%）', en: 'Favourable answers by question (%)' },
      axes: { label: { ja: '設問', en: 'Question' }, value: { ja: '割合', en: 'Share' } },
    },
    {
      kind: 'bar',
      field: 'channels',
      label: 'channel',
      value: 'overall',
      title: { ja: '窓口別の総合満足度（平均）', en: 'Overall satisfaction by channel (mean)' },
      axes: { label: { ja: '窓口', en: 'Channel' }, value: { ja: '平均', en: 'Mean' } },
    },
  ],
});
