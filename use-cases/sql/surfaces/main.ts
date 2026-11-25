import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'sql',
  title: 'SQLアシスタント / SQL assistant',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      'テーブルの書き出しと、知りたいことを指定してください。 / Name the table export and your question.',
    suggestedPrompts: [
      '受注_orders_2026年9月-11月.csv で、2026年10月の地域別の売上（取消を除く）を出して。SQLも見せて',
      'In orders-export-2026-09-to-11.csv, show October 2026 sales by region without cancelled orders, with the SQL',
      '受注_orders_2026年9月-11月.csv で、関東の商品分類別の注文件数を、取消も含めて出して',
      'In orders-export-2026-09-to-11.csv, count all Kanto orders by category, cancelled ones included',
    ],
    disclaimer:
      '書き出したデータでの計算です。データベースには接続しません。 / From the export; it never connects to a database.',
    toolTrace: 'collapsed',
    history: true,
  },
  // The typed output's rows, drawn under the answer (ADR-0168): field, row label and row value.
  resultCharts: [
    {
      kind: 'bar',
      field: 'rows',
      label: 'group',
      value: 'total',
      title: { ja: 'クエリの結果', en: 'The query result' },
      axes: { label: { ja: 'グループ', en: 'Group' }, value: { ja: '合計', en: 'Total' } },
    },
  ],
});
