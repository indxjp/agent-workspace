import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'territory',
  area: 'sales',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/territory',
  name: {
    ja: '営業エリア計画',
    en: 'Territory planner',
  },
  summary: {
    ja: '顧客リストと実績から、担当エリアの配分案を作る。',
    en: 'Proposes territory assignments from customers and results.',
  },
  demo: {
    agent: 'territory',
    prompts: [
      {
        ja: '顧客一覧_2026年度上期.csv で、売上が均等になるように3つのエリアに分ける案を作って',
        en: 'In customer-list-fy2026-h1.csv, propose three territories with even sales',
      },
      {
        ja: '顧客一覧_2026年度上期.csv で、訪問回数が均等になるように4つのエリアに分ける案を作って',
        en: 'In customer-list-fy2026-h1.csv, propose four territories with an even number of visits',
      },
    ],
    moment: {
      ja: '顧客一覧のCSVからスクリプトが都道府県ごとの売上と訪問回数を集計し、決まった規則で均等に分けたエリア案と、エリア別のグラフが計算どおりの数値で示される。担当者の評価や順位は出さない。',
      en: 'A script totals sales and visits by prefecture from the customer CSV and splits the areas evenly by a fixed rule, and the proposed territories and a chart by territory show exactly its numbers. No salesperson is rated or ranked.',
    },
    data: {
      ja: '架空の部品商社の顧客一覧（顧客・都道府県・担当者・年間売上・訪問回数・備考）のCSV',
      en: 'A customer list CSV of a fictional parts trader (customer, prefecture, owner, annual sales, visits, note)',
    },
    seed: [
      {
        collection: 'territory',
        from: 'data',
      },
    ],
    check: {
      tools: ['run_skill_script'],
      approval: null,
    },
    // The suggested eval case's schema (evals/territory.yaml); the surface charts it.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['by', 'count', 'total', 'spread', 'spreadPct', 'territories', 'commentary'],
      properties: {
        by: { type: 'string', enum: ['sales', 'visits', 'accounts'] },
        count: { type: 'integer' },
        total: { type: 'number' },
        spread: { type: 'number' },
        spreadPct: { type: 'number' },
        territories: {
          type: 'array',
          maxItems: 9,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['territory', 'areas', 'accounts', 'sales', 'visits', 'value', 'sharePct'],
            properties: {
              territory: { type: 'string' },
              areas: { type: 'array', items: { type: 'string' } },
              accounts: { type: 'integer' },
              sales: { type: 'number' },
              visits: { type: 'number' },
              value: { type: 'number' },
              sharePct: { type: 'number' },
            },
          },
        },
        commentary: { type: 'string' },
      },
    },
  },
  safety: ['person', 'files', 'structured'],
});
