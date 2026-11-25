import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'forecast',
  title: '売上予測 / Sales forecast',
  layout: 'page',
  parts: {
    attachments: true,
    greeting: '商談一覧のCSVと四半期を指定してください。 / Name the deal CSV and the quarter.',
    suggestedPrompts: [
      '商談一覧_2026年度下期.csv で2026年第4四半期の着地見込みを出して',
      'Forecast the fourth quarter of 2026 from deals-FY2026-H2.csv',
      '商談一覧_2026年度下期.csv で、2026年第4四半期の目標4500万円に対して見込みがどれだけ足りないか教えて',
      'In deals-FY2026-H2.csv, how far is the fourth quarter of 2026 forecast from a target of 45,000,000 yen?',
    ],
    disclaimer: '数値はスクリプトの計算結果です。判断は担当者が行います。 / A person decides.',
    toolTrace: 'collapsed',
    history: true,
  },
  // The typed output's rows, drawn under the answer (ADR-0168): field, row label and row value.
  resultCharts: [
    {
      kind: 'bar',
      field: 'months',
      label: 'month',
      value: 'forecast',
      title: { ja: '月別の着地見込み（円）', en: 'Forecast by month (yen)' },
      axes: { label: { ja: '月', en: 'Month' }, value: { ja: '見込み', en: 'Forecast' } },
    },
    {
      kind: 'bar',
      field: 'deals',
      label: 'deal',
      value: 'weighted',
      title: { ja: '商談中の案件の加重金額（円）', en: 'Weighted amount of open deals (yen)' },
      axes: { label: { ja: '案件', en: 'Deal' }, value: { ja: '加重金額', en: 'Weighted' } },
    },
  ],
});
