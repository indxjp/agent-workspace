import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'segments',
  title: '顧客セグメント分析 / Customer segments',
  layout: 'page',
  parts: {
    attachments: true,
    greeting: '分析する注文明細のCSVを指定してください。 / Name the order export to analyse.',
    suggestedPrompts: [
      '注文明細_2025年12月-2026年11月.csv で顧客をセグメントに分けて、それぞれの特徴を説明して',
      'Segment the customers in orders-2025-12-to-2026-11.csv and describe each group',
      '注文明細_2025年12月-2026年11月.csv で、2026年8月31日時点の顧客セグメントを示して',
      'Show the customer segments in orders-2025-12-to-2026-11.csv as of 31 August 2026',
    ],
    disclaimer: '数値はスクリプトの計算結果です。施策は担当者が決めます。 / A person decides.',
    toolTrace: 'collapsed',
    history: true,
  },
  // The typed output's rows, drawn under the answer (ADR-0168): field, row label and row value.
  resultCharts: [
    {
      kind: 'bar',
      field: 'segments',
      label: 'segment',
      value: 'customers',
      title: { ja: 'セグメント別の顧客数', en: 'Customers by segment' },
      axes: {
        label: { ja: 'セグメント', en: 'Segment' },
        value: { ja: '顧客数', en: 'Customers' },
      },
    },
    {
      kind: 'bar',
      field: 'segments',
      label: 'segment',
      value: 'revenue',
      title: { ja: 'セグメント別の売上（円）', en: 'Revenue by segment (yen)' },
      axes: { label: { ja: 'セグメント', en: 'Segment' }, value: { ja: '売上', en: 'Revenue' } },
    },
  ],
});
