import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'sql',
  area: 'it',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/sql',
  name: {
    ja: 'SQLアシスタント',
    en: 'SQL assistant',
  },
  summary: {
    ja: '日本語の質問をSQLにして、結果を表とグラフで返す。',
    en: 'Turns a question into SQL and returns a table and chart.',
  },
  demo: {
    agent: 'sql',
    prompts: [
      {
        ja: '受注_orders_2026年9月-11月.csv で、2026年10月の地域別の売上（取消を除く）を出して。SQLも見せて',
        en: 'In orders-export-2026-09-to-11.csv, show October 2026 sales by region without cancelled orders, with the SQL',
      },
      {
        ja: '受注_orders_2026年9月-11月.csv で、関東の商品分類別の注文件数を、取消も含めて出して',
        en: 'In orders-export-2026-09-to-11.csv, count all Kanto orders by category, cancelled ones included',
      },
    ],
    moment: {
      ja: '質問からスクリプトが読み取り専用のSELECT文を作り、同じ集計を受注テーブルの書き出しで計算して、SQLと結果の表・グラフが計算どおりの数値で示される。データベースには接続しない。',
      en: 'A script turns the question into a read-only SELECT statement and computes the same aggregate from the orders table export, and the SQL, the result table and a chart show exactly its numbers. It never connects to a database.',
    },
    data: {
      ja: '架空の文具卸の受注テーブルの書き出し（CSV）と、そのスキーマ（CREATE TABLE文とコメント）',
      en: "An export of a fictional stationery wholesaler's orders table (CSV) and its schema (the CREATE TABLE statement with comments)",
    },
    seed: [
      {
        collection: 'sql',
        from: 'data',
      },
    ],
    check: {
      tools: ['run_skill_script'],
      approval: null,
    },
    // The suggested eval case's schema (evals/sql.yaml); the surface charts it.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['table', 'sql', 'rowsRead', 'rowsKept', 'total', 'rows', 'commentary'],
      properties: {
        table: { type: 'string' },
        sql: { type: 'string', pattern: '^SELECT ' },
        rowsRead: { type: 'integer' },
        rowsKept: { type: 'integer' },
        total: { type: 'number' },
        rows: {
          type: 'array',
          maxItems: 200,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['group', 'total'],
            properties: { group: { type: 'string' }, total: { type: 'number' } },
          },
        },
        commentary: { type: 'string' },
      },
    },
  },
  safety: ['person', 'files', 'structured'],
});
