import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'forecast',
  area: 'analytics',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/forecast',
  name: {
    ja: '売上予測',
    en: 'Sales forecast',
  },
  summary: {
    ja: '過去の実績と商談の状況から今期の着地見込みを作る。',
    en: 'Forecasts the quarter from history and the pipeline.',
  },
  demo: {
    agent: 'forecast',
    prompts: [
      {
        ja: '商談一覧_2026年度下期.csv で2026年第4四半期の着地見込みを出して',
        en: 'Forecast the fourth quarter of 2026 from deals-FY2026-H2.csv',
      },
      {
        ja: '商談一覧_2026年度下期.csv で、2026年第4四半期の目標4500万円に対して見込みがどれだけ足りないか教えて',
        en: 'In deals-FY2026-H2.csv, how far is the fourth quarter of 2026 forecast from a target of 45,000,000 yen?',
      },
    ],
    moment: {
      ja: '商談一覧のCSVからスクリプトが受注済みの金額と確度で加重したパイプラインを計算し、四半期の着地見込みと月別のグラフが計算どおりの数値で示される。',
      en: 'A script computes the won amount and the probability-weighted pipeline from the deal CSV, and the quarter forecast and a chart by month show exactly its numbers.',
    },
    data: {
      ja: '架空の顧客との下期の商談一覧のCSVと、備考付きの営業課別のCSV',
      en: 'A CSV of second-half deals with fictional customers, and a sales team CSV with notes',
    },
    seed: [{ collection: 'forecast', from: 'data' }],
    check: { tools: ['run_skill_script'], approval: null },
    // The suggested eval case's schema (evals/forecast.yaml); the surface charts months and deals.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['quarter', 'months', 'total', 'target', 'lost', 'deals', 'commentary'],
      properties: {
        quarter: { type: 'string', pattern: '^\\d{4}-Q[1-4]$' },
        months: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['month', 'won', 'weighted', 'pipeline', 'forecast'],
            properties: {
              month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
              won: { type: 'integer' },
              weighted: { type: 'integer' },
              pipeline: { type: 'integer' },
              forecast: { type: 'integer' },
            },
          },
        },
        total: {
          type: 'object',
          additionalProperties: false,
          required: ['won', 'weighted', 'pipeline', 'forecast', 'bestCase'],
          properties: {
            won: { type: 'integer' },
            weighted: { type: 'integer' },
            pipeline: { type: 'integer' },
            forecast: { type: 'integer' },
            bestCase: { type: 'integer' },
          },
        },
        target: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['target', 'gap', 'attainmentPct'],
          properties: {
            target: { type: 'integer' },
            gap: { type: 'integer' },
            attainmentPct: { type: 'number' },
          },
        },
        lost: {
          type: 'object',
          additionalProperties: false,
          required: ['count', 'amount'],
          properties: { count: { type: 'integer' }, amount: { type: 'integer' } },
        },
        deals: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['deal', 'customer', 'amount', 'probability', 'month', 'weighted'],
            properties: {
              deal: { type: 'string' },
              customer: { type: 'string' },
              amount: { type: 'integer' },
              probability: { type: 'integer' },
              month: { type: 'string' },
              weighted: { type: 'integer' },
            },
          },
        },
        commentary: { type: 'string' },
      },
    },
  },
  safety: ['person', 'files', 'structured'],
});
