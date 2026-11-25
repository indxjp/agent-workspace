import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: '__slug__',
  title: '分析 / Analysis',
  layout: 'page',
  parts: {
    attachments: true,
    greeting: '分析するCSVを指定してください。 / Name the CSV to analyse.',
    suggestedPrompts: [
      'records.csv を集計して',
      'Total records.csv',
      'records.csv で合計の大きい項目を挙げて',
      'List the largest totals in records.csv',
    ],
    disclaimer: '数値はスクリプトの計算結果です。判断は担当者が行います。 / A person decides.',
    toolTrace: 'collapsed',
    history: true,
  },
  // The typed output's rows, drawn under the answer (ADR-0168): field, row label and row value.
  resultCharts: [
    {
      kind: 'bar',
      field: 'points',
      label: 'label',
      value: 'value',
      title: { ja: '集計', en: 'Totals' },
      axes: { label: { ja: '項目', en: 'Item' }, value: { ja: '合計', en: 'Total' } },
    },
  ],
});
