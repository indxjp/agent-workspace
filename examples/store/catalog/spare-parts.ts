import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'spare-parts',
  area: 'mfg',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/spare-parts',
  name: {
    ja: '保守部品の手配',
    en: 'Spare parts planner',
  },
  summary: {
    ja: '故障の傾向と在庫から、発注すべき保守部品を提案する。',
    en: 'Suggests spare parts to order from failure trends and stock.',
  },
  demo: {
    agent: 'spare-parts',
    prompts: [
      {
        ja: '部品在庫_2026年10月末.csv と 部品使用実績_2026年5月-10月.csv から、今発注すべき保守部品を挙げて',
        en: 'From spare-parts-stock-2026-10-end.csv and parts-usage-2026-05-to-10.csv, list the spare parts to order now',
      },
      {
        ja: '部品在庫_2026年10月末.csv と 部品使用実績_2026年5月-10月.csv で、直近3か月の使用実績だけをもとに発注すべき部品を挙げて',
        en: 'Using only the last three months of parts-usage-2026-05-to-10.csv, list the parts to order from spare-parts-stock-2026-10-end.csv',
      },
    ],
    moment: {
      ja: '在庫一覧と使用実績からスクリプトが発注点と発注数を計算し、発注すべき部品と月別の使用数のグラフが計算どおりの数値で示される。',
      en: 'A script computes each part’s reorder point and order quantity from the stock list and the usage log, and the parts to order and a chart of use by month show exactly its numbers.',
    },
    data: {
      ja: '架空の工場の保守部品の在庫一覧、修理記録からの部品使用実績（月次）、備考付きの再提出の在庫一覧のCSV',
      en: 'CSVs of a fictional plant’s spare-parts stock list, its monthly parts usage from repair records, and a resubmitted stock list with notes',
    },
    seed: [{ collection: 'spare-parts', from: 'data' }],
    check: { tools: ['run_skill_script'], approval: null },
    // The suggested eval case's schema (evals/spare-parts.yaml); the surface charts toOrder and trend.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to', 'months', 'toOrder', 'trend', 'commentary'],
      properties: {
        from: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}$',
        },
        to: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}$',
        },
        months: {
          type: 'integer',
        },
        toOrder: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'partNo',
              'partName',
              'equipment',
              'used',
              'avgMonthly',
              'reorderPoint',
              'onHand',
              'onOrder',
              'available',
              'coveredByOrder',
              'order',
              'rising',
            ],
            properties: {
              partNo: {
                type: 'string',
              },
              partName: {
                type: 'string',
              },
              equipment: {
                type: 'string',
              },
              used: {
                type: 'integer',
              },
              avgMonthly: {
                type: 'number',
              },
              reorderPoint: {
                type: 'integer',
              },
              onHand: {
                type: 'integer',
              },
              onOrder: {
                type: 'integer',
              },
              available: {
                type: 'integer',
              },
              coveredByOrder: {
                type: 'boolean',
              },
              order: {
                type: 'integer',
              },
              rising: {
                type: 'boolean',
              },
            },
          },
        },
        trend: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['month', 'used'],
            properties: {
              month: {
                type: 'string',
              },
              used: {
                type: 'integer',
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
