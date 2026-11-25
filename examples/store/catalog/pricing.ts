import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'pricing',
  area: 'analytics',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/pricing',
  name: {
    ja: '価格分析',
    en: 'Pricing analyst',
  },
  summary: {
    ja: '値上げや値下げの影響を過去のデータから試算する。',
    en: 'Estimates the effect of price changes from history.',
  },
  demo: {
    agent: 'pricing',
    prompts: [
      {
        ja: '商品別売上_2025年12月-2026年11月.csv で、全商品を5%値上げした場合の売上への影響を試算して',
        en: 'Using sales-by-product-2025-12-to-2026-11.csv, estimate the effect on sales of a 5% price increase on every product',
      },
      {
        ja: '商品別売上_2025年12月-2026年11月.csv で、全商品を10%値下げした場合の影響を試算して',
        en: 'Using sales-by-product-2025-12-to-2026-11.csv, estimate the effect of a 10% price cut on every product',
      },
    ],
    moment: {
      ja: 'スクリプトが過去の値上げ・値下げでの数量の動きから商品ごとの価格弾力性を求め、指定した価格変更での売上の増減の試算が、商品別のグラフと計算どおりの数値で示される。',
      en: 'A script works out each product’s price elasticity from how quantities moved at past price changes, and the estimated change in revenue for the price change asked for shows in a chart by product with exactly its numbers.',
    },
    data: {
      ja: '架空のコーヒー豆の通販の商品別・月別の単価と販売数量（1年分）と、備考付きの同じデータのCSV',
      en: 'CSVs of a fictional coffee shop’s monthly unit prices and quantities sold by product over a year, and the same data with a note column',
    },
    seed: [{ collection: 'pricing', from: 'data' }],
    check: { tools: ['run_skill_script'], approval: null },
    // The suggested eval case's schema (evals/pricing.yaml); the surface charts it.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['change', 'from', 'to', 'products', 'total', 'noHistory', 'trend', 'commentary'],
      properties: {
        change: {
          type: 'number',
        },
        from: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}$',
        },
        to: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}$',
        },
        products: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'productCode',
              'productName',
              'price',
              'quantity',
              'revenue',
              'elasticity',
              'newPrice',
              'estQuantity',
              'estRevenue',
              'revenueChange',
              'revenueChangePct',
            ],
            properties: {
              productCode: {
                type: 'string',
              },
              productName: {
                type: 'string',
              },
              price: {
                type: 'integer',
              },
              quantity: {
                type: 'integer',
              },
              revenue: {
                type: 'integer',
              },
              elasticity: {
                type: 'number',
              },
              newPrice: {
                type: 'integer',
              },
              estQuantity: {
                type: 'integer',
              },
              estRevenue: {
                type: 'integer',
              },
              revenueChange: {
                type: 'integer',
              },
              revenueChangePct: {
                type: ['number', 'null'],
              },
            },
          },
        },
        total: {
          type: 'object',
          additionalProperties: false,
          required: ['revenue', 'estRevenue', 'revenueChange'],
          properties: {
            revenue: {
              type: 'integer',
            },
            estRevenue: {
              type: 'integer',
            },
            revenueChange: {
              type: 'integer',
            },
          },
        },
        noHistory: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['productCode', 'productName'],
            properties: {
              productCode: {
                type: 'string',
              },
              productName: {
                type: 'string',
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
            required: ['month', 'revenue'],
            properties: {
              month: {
                type: 'string',
              },
              revenue: {
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
