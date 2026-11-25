import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'territory',
  title: '営業エリア計画 / Territory planner',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '顧客一覧のCSVと、分けるエリアの数を指定してください。 / Name the customer CSV and how many territories.',
    suggestedPrompts: [
      '顧客一覧_2026年度上期.csv で、売上が均等になるように3つのエリアに分ける案を作って',
      'In customer-list-fy2026-h1.csv, propose three territories with even sales',
      '顧客一覧_2026年度上期.csv で、訪問回数が均等になるように4つのエリアに分ける案を作って',
      'In customer-list-fy2026-h1.csv, propose four territories with an even number of visits',
    ],
    disclaimer:
      '数値はスクリプトの計算結果です。エリアと担当は人が決めます。 / A person decides the territories and who covers them.',
    toolTrace: 'collapsed',
    history: true,
  },
  // The typed output's rows, drawn under the answer (ADR-0168): field, row label and row value.
  resultCharts: [
    {
      kind: 'bar',
      field: 'territories',
      label: 'territory',
      value: 'value',
      title: {
        ja: 'エリア別の配分（均等にした指標）',
        en: 'Each territory (the balanced measure)',
      },
      axes: { label: { ja: 'エリア', en: 'Territory' }, value: { ja: '値', en: 'Value' } },
    },
  ],
});
