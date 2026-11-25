import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'budget',
  title: '予実差異分析 / Budget variance',
  layout: 'page',
  parts: {
    attachments: true,
    greeting: '分析する予実のCSVと月を指定してください。 / Name the budget CSV and the month.',
    suggestedPrompts: [
      '予実_2026年度上期_部門別.csv で2026年9月の予実差異を分析して',
      'Analyse the September 2026 budget variance in budget-actual-FY2026-H1-by-department.csv',
      '予実_2026年度上期_部門別.csv で、2026年9月に予算から15%以上ずれた行だけを挙げて',
      'In budget-actual-FY2026-H1-by-department.csv, list only the September 2026 lines 15% or more off budget',
    ],
    disclaimer: '数値はスクリプトの計算結果です。判断は担当者が行います。 / A person decides.',
    toolTrace: 'collapsed',
    history: true,
  },
  // The typed output's rows, drawn under the answer (ADR-0168): field, row label and row value.
  resultCharts: [
    {
      kind: 'bar',
      field: 'departments',
      label: 'department',
      value: 'variance',
      title: { ja: '部門別の差異（当月・円）', en: 'Variance by department (month, yen)' },
      axes: { label: { ja: '部門', en: 'Department' }, value: { ja: '差異', en: 'Variance' } },
    },
    {
      kind: 'line',
      field: 'trend',
      label: 'month',
      value: 'variance',
      title: { ja: '月別の差異（円）', en: 'Variance by month (yen)' },
      axes: { label: { ja: '月', en: 'Month' }, value: { ja: '差異', en: 'Variance' } },
    },
  ],
});
