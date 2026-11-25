import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'cash',
  area: 'finance',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/cash',
  name: {
    ja: '資金繰り予測',
    en: 'Cash forecast',
  },
  summary: {
    ja: '入出金の予定と口座残高から、13週間の資金繰り表をスクリプトで計算し、最低残高を下回る週を示す。',
    en: 'Computes a 13-week cash forecast from scheduled flows and bank balances with a script, and shows the weeks below a minimum balance.',
  },
  demo: {
    agent: 'cash',
    prompts: [
      {
        ja: '入出金予定_2026-11-20.csv と 口座残高_2026-11-20.csv で13週間の資金繰り表を作って',
        en: 'Build the 13-week cash forecast from scheduled-flows_2026-11-20.csv and bank-balances_2026-11-20.csv',
      },
      {
        ja: '入出金予定_2026-11-20.csv と 口座残高_2026-11-20.csv で、残高が1,500万円を下回る週を挙げて',
        en: 'From scheduled-flows_2026-11-20.csv and bank-balances_2026-11-20.csv, list the weeks whose balance falls below 15 million yen',
      },
    ],
    moment: {
      ja: '入出金予定と口座残高からスクリプトが13週の収支と週末残高を計算し、最も低い週と週末残高のグラフが計算どおりの数値で示される。',
      en: 'A script computes 13 weeks of net flow and closing balance from the scheduled flows and bank balances, and the lowest week and a chart of the closing balance show exactly its numbers.',
    },
    data: {
      ja: '架空の会社の入出金予定（13週間分）と口座残高のCSV',
      en: 'a fictional company’s scheduled receipts and payments (13 weeks) and bank balances as CSV',
    },
    seed: [{ collection: 'cash', from: 'data' }],
    check: { tools: ['run_skill_script'], approval: null },
    // The suggested eval case's schema (evals/cash.yaml); the surface charts weeks.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['asOf', 'opening', 'minimum', 'weeks', 'lowest', 'short', 'commentary'],
      properties: {
        asOf: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        opening: { type: 'integer' },
        minimum: { type: 'integer' },
        weeks: {
          type: 'array',
          maxItems: 13,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['week', 'inflow', 'outflow', 'net', 'closing', 'short'],
            properties: {
              week: { type: 'string' },
              inflow: { type: 'integer' },
              outflow: { type: 'integer' },
              net: { type: 'integer' },
              closing: { type: 'integer' },
              short: { type: 'boolean' },
            },
          },
        },
        lowest: {
          type: 'object',
          additionalProperties: false,
          required: ['week', 'closing'],
          properties: { week: { type: 'string' }, closing: { type: 'integer' } },
        },
        short: { type: 'array', items: { type: 'string' } },
        commentary: { type: 'string' },
      },
    },
  },
  safety: ['person', 'files', 'structured'],
});
