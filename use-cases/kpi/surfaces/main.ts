import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'kpi',
  title: 'KPIレポート / KPI report',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '分析する週次KPIのCSVと週を指定してください。 / Name the weekly KPI CSV and the week.',
    suggestedPrompts: [
      '週次KPI_2026年9月-11月.csv で、最新の週に大きく動いた指標を解説して',
      'In weekly-kpi-2026-09-to-11.csv, explain the metrics that moved in the latest week',
      '週次KPI_2026年9月-11月.csv で、2026-10-26の週に前週から20%以上動いた指標だけを挙げて',
      'In weekly-kpi-2026-09-to-11.csv, list only the metrics that moved 20% or more in the week of 2026-10-26',
    ],
    disclaimer: '数値はスクリプトの計算結果です。判断は担当者が行います。 / A person decides.',
    toolTrace: 'collapsed',
    history: true,
  },
  // The typed output's rows, drawn under the answer (ADR-0168): field, row label and row value.
  resultCharts: [
    {
      kind: 'bar',
      field: 'changes',
      label: 'metric',
      value: 'changePct',
      title: { ja: '指標別の前週比（%）', en: 'Change on the previous week by metric (%)' },
      axes: { label: { ja: '指標', en: 'Metric' }, value: { ja: '前週比', en: 'Change' } },
    },
  ],
});
