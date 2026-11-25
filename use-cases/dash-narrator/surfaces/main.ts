import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'dash-narrator',
  title: 'ダッシュボード解説 / Dashboard narrator',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '解説するダッシュボードのデータ（CSV）と期間を指定してください。 / Name the dashboard data (CSV) and the period.',
    suggestedPrompts: [
      'ダッシュボード_ECサイト_2026年10月.csv のグラフの動きを解説して、確認すべき点を挙げて',
      'Explain what the charts in dashboard-online-shop-2026-10.csv show, and what to check',
      'ダッシュボード_ECサイト_2026年10月.csv で、2026年10月12日から18日の週だけを解説して',
      'In dashboard-online-shop-2026-10.csv, explain only the week of 12 to 18 October 2026',
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
      title: { ja: '指標別の変化率（%）', en: 'Change by metric (%)' },
      axes: { label: { ja: '指標', en: 'Metric' }, value: { ja: '変化率', en: 'Change' } },
    },
  ],
});
