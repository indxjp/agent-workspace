import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'spare-parts',
  title: '保守部品の手配 / Spare parts planner',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '部品の在庫一覧と使用実績のCSVを指定してください。 / Name the stock list and the usage log.',
    suggestedPrompts: [
      '部品在庫_2026年10月末.csv と 部品使用実績_2026年5月-10月.csv から、今発注すべき保守部品を挙げて',
      'From spare-parts-stock-2026-10-end.csv and parts-usage-2026-05-to-10.csv, list the spare parts to order now',
      '部品在庫_2026年10月末.csv と 部品使用実績_2026年5月-10月.csv で、直近3か月の使用実績だけをもとに発注すべき部品を挙げて',
      'Using only the last three months of parts-usage-2026-05-to-10.csv, list the parts to order from spare-parts-stock-2026-10-end.csv',
    ],
    disclaimer:
      '数値はスクリプトの計算結果です。発注は担当者が判断します。 / A person decides what to order.',
    toolTrace: 'collapsed',
    history: true,
  },
  // The typed output's rows, drawn under the answer (ADR-0168): field, row label and row value.
  resultCharts: [
    {
      kind: 'bar',
      field: 'toOrder',
      label: 'partNo',
      value: 'order',
      title: { ja: '発注する数量（部品別）', en: 'Quantity to order by part' },
      axes: { label: { ja: '部品番号', en: 'Part' }, value: { ja: '数量', en: 'Quantity' } },
    },
    {
      kind: 'line',
      field: 'trend',
      label: 'month',
      value: 'used',
      title: { ja: '月別の部品使用数', en: 'Parts used by month' },
      axes: { label: { ja: '月', en: 'Month' }, value: { ja: '使用数', en: 'Used' } },
    },
  ],
});
