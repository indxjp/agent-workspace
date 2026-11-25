import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'cash',
  title: '資金繰り予測 / Cash forecast',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '入出金予定と口座残高のファイルを指定してください。13週間の資金繰り表を計算します。 / Name the scheduled flows and the bank balances; I compute the 13-week forecast.',
    suggestedPrompts: [
      '入出金予定_2026-11-20.csv と 口座残高_2026-11-20.csv で13週間の資金繰り表を作って',
      'Build the 13-week cash forecast from scheduled-flows_2026-11-20.csv and bank-balances_2026-11-20.csv',
      '入出金予定_2026-11-20.csv と 口座残高_2026-11-20.csv で、残高が1,500万円を下回る週を挙げて',
      'From scheduled-flows_2026-11-20.csv and bank-balances_2026-11-20.csv, list the weeks whose balance falls below 15 million yen',
    ],
    disclaimer: '数値はスクリプトの計算結果です。判断は担当者が行います。 / A person decides.',
    toolTrace: 'collapsed',
    history: true,
  },
  // The typed output's rows, drawn under the answer (ADR-0168): field, row label and row value.
  resultCharts: [
    {
      kind: 'line',
      field: 'weeks',
      label: 'week',
      value: 'closing',
      title: { ja: '週末の残高（円）', en: 'Closing balance by week (yen)' },
      axes: { label: { ja: '週末日', en: 'Week ending' }, value: { ja: '残高', en: 'Balance' } },
    },
    {
      kind: 'bar',
      field: 'weeks',
      label: 'week',
      value: 'net',
      title: { ja: '週ごとの収支（円）', en: 'Net flow by week (yen)' },
      axes: { label: { ja: '週末日', en: 'Week ending' }, value: { ja: '収支', en: 'Net' } },
    },
  ],
});
