import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'dash-narrator',
  area: 'analytics',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/dash-narrator',
  name: {
    ja: 'ダッシュボード解説',
    en: 'Dashboard narrator',
  },
  summary: {
    ja: 'グラフの動きを文章で説明し、確認すべき点を挙げる。',
    en: 'Explains what the charts show and what to check.',
  },
  demo: {
    agent: 'dash-narrator',
    prompts: [
      {
        ja: 'ダッシュボード_ECサイト_2026年10月.csv のグラフの動きを解説して、確認すべき点を挙げて',
        en: 'Explain what the charts in dashboard-online-shop-2026-10.csv show, and what to check',
      },
      {
        ja: 'ダッシュボード_ECサイト_2026年10月.csv で、2026年10月12日から18日の週だけを解説して',
        en: 'In dashboard-online-shop-2026-10.csv, explain only the week of 12 to 18 October 2026',
      },
    ],
    moment: {
      ja: 'ダッシュボードのデータからスクリプトが指標ごとの変化・山・谷と平均から離れた点を計算し、確認すべき点と指標別のグラフが計算どおりの数値で示される。',
      en: 'A script computes each metric’s change, peak, low and unusual points from the dashboard data, and what to check and a chart by metric show exactly its numbers.',
    },
    data: {
      ja: '架空のECサイトのダッシュボードの日次データ（訪問数・注文数・売上・平均注文単価）のCSVと、備考付きの問い合わせダッシュボードのCSV',
      en: 'A CSV of a fictional online shop dashboard’s daily data (visits, orders, sales, average order value), and a support dashboard CSV with notes',
    },
    seed: [{ collection: 'dash-narrator', from: 'data' }],
    check: { tools: ['run_skill_script'], approval: null },
    // The suggested eval case's schema (evals/dash-narrator.yaml); the surface charts metrics.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to', 'z', 'metrics', 'unusual', 'changes', 'commentary'],
      properties: {
        from: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        },
        to: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        },
        z: {
          type: 'number',
        },
        metrics: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['metric', 'first', 'last', 'change', 'changePct', 'mean', 'peak', 'low'],
            properties: {
              metric: {
                type: 'string',
              },
              first: {
                type: 'number',
              },
              last: {
                type: 'number',
              },
              change: {
                type: 'number',
              },
              changePct: {
                type: ['number', 'null'],
              },
              mean: {
                type: 'number',
              },
              peak: {
                $ref: '#/$defs/point',
              },
              low: {
                $ref: '#/$defs/point',
              },
            },
          },
        },
        unusual: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['metric', 'date', 'value', 'z'],
            properties: {
              metric: {
                type: 'string',
              },
              date: {
                type: 'string',
              },
              value: {
                type: 'number',
              },
              z: {
                type: 'number',
              },
            },
          },
        },
        changes: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['metric', 'changePct'],
            properties: {
              metric: {
                type: 'string',
              },
              changePct: {
                type: 'number',
              },
            },
          },
        },
        commentary: {
          type: 'string',
        },
      },
      $defs: {
        point: {
          type: 'object',
          additionalProperties: false,
          required: ['date', 'value'],
          properties: {
            date: {
              type: 'string',
            },
            value: {
              type: 'number',
            },
          },
        },
      },
    },
  },
  safety: ['person', 'files', 'structured'],
});
