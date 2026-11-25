import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'segments',
  area: 'analytics',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/segments',
  name: {
    ja: '顧客セグメント分析',
    en: 'Customer segments',
  },
  summary: {
    ja: '購買データから顧客をグループに分け、特徴を説明する。',
    en: 'Groups customers from purchase data and describes each group.',
  },
  demo: {
    agent: 'segments',
    prompts: [
      {
        ja: '注文明細_2025年12月-2026年11月.csv で顧客をセグメントに分けて、それぞれの特徴を説明して',
        en: 'Segment the customers in orders-2025-12-to-2026-11.csv and describe each group',
      },
      {
        ja: '注文明細_2025年12月-2026年11月.csv で、2026年8月31日時点の顧客セグメントを示して',
        en: 'Show the customer segments in orders-2025-12-to-2026-11.csv as of 31 August 2026',
      },
    ],
    moment: {
      ja: 'スクリプトが注文明細から決まったルールで顧客をセグメントに分け、セグメント別の顧客数と売上のグラフが計算どおりの数値で示される。',
      en: 'A script groups the customers of an order export into segments by fixed rules, and the charts of customers and revenue by segment show exactly its numbers.',
    },
    data: {
      ja: '架空の通販サイトの1年分の注文明細と、備考付きの同じ注文明細のCSV',
      en: 'CSVs of a fictional online shop’s orders over a year, and the same orders with a note column',
    },
    seed: [{ collection: 'segments', from: 'data' }],
    check: { tools: ['run_skill_script'], approval: null },
    // The suggested eval case's schema (evals/segments.yaml); the surface charts it.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['asOf', 'from', 'recentDays', 'lapsedDays', 'total', 'segments', 'commentary'],
      properties: {
        asOf: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        },
        from: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        },
        recentDays: {
          type: 'integer',
        },
        lapsedDays: {
          type: 'integer',
        },
        total: {
          type: 'object',
          additionalProperties: false,
          required: ['customers', 'orders', 'revenue'],
          properties: {
            customers: {
              type: 'integer',
            },
            orders: {
              type: 'integer',
            },
            revenue: {
              type: 'integer',
            },
          },
        },
        segments: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'segment',
              'customers',
              'orders',
              'revenue',
              'share',
              'avgOrders',
              'avgDays',
              'topCategory',
            ],
            properties: {
              segment: {
                type: 'string',
              },
              customers: {
                type: 'integer',
              },
              orders: {
                type: 'integer',
              },
              revenue: {
                type: 'integer',
              },
              share: {
                type: 'number',
              },
              avgOrders: {
                type: 'number',
              },
              avgDays: {
                type: 'integer',
              },
              topCategory: {
                type: 'string',
              },
            },
          },
        },
        commentary: {
          type: 'string',
        },
      },
    },
  },
  safety: ['person', 'files', 'structured'],
});
