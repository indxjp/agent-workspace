import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'kpi',
  area: 'analytics',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/kpi',
  name: {
    ja: 'KPIレポート',
    en: 'KPI report',
  },
  summary: {
    ja: '毎週の数字を集め、大きく動いた指標を解説付きで報告する。',
    en: 'Collects weekly numbers and explains the metrics that moved.',
  },
  demo: {
    agent: 'kpi',
    prompts: [
      {
        ja: '週次KPI_2026年9月-11月.csv で、最新の週に大きく動いた指標を解説して',
        en: 'In weekly-kpi-2026-09-to-11.csv, explain the metrics that moved in the latest week',
      },
      {
        ja: '週次KPI_2026年9月-11月.csv で、2026-10-26の週に前週から20%以上動いた指標だけを挙げて',
        en: 'In weekly-kpi-2026-09-to-11.csv, list only the metrics that moved 20% or more in the week of 2026-10-26',
      },
    ],
    moment: {
      ja: '週次KPIのCSVからスクリプトが前週比と直近の平均を計算し、大きく動いた指標と指標別のグラフが計算どおりの数値で示される。',
      en: 'A script computes each metric’s change on the previous week and its recent mean from the weekly KPI CSV, and the metrics that moved and a chart by metric show exactly its numbers.',
    },
    data: {
      ja: '架空の会員サービスの週次KPI（会員数・受注・売上・解約率・応答時間・問い合わせ）のCSVと、備考付きの差替CSV',
      en: 'A weekly KPI CSV of a fictional membership service (members, orders, revenue, churn, response time, enquiries), and a resubmitted CSV with notes',
    },
    seed: [{ collection: 'kpi', from: 'data' }],
    check: { tools: ['run_skill_script'], approval: null },
    // The suggested eval case's schema (evals/kpi.yaml); the surface charts metrics.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['week', 'previousWeek', 'threshold', 'metrics', 'moved', 'changes', 'commentary'],
      properties: {
        week: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        },
        previousWeek: {
          type: ['string', 'null'],
        },
        threshold: {
          type: 'number',
        },
        metrics: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'metric',
              'unit',
              'value',
              'previous',
              'change',
              'changePct',
              'avg4',
              'moved',
              'note',
            ],
            properties: {
              metric: {
                type: 'string',
              },
              unit: {
                type: 'string',
              },
              value: {
                type: 'number',
              },
              previous: {
                type: ['number', 'null'],
              },
              change: {
                type: ['number', 'null'],
              },
              changePct: {
                type: ['number', 'null'],
              },
              avg4: {
                type: ['number', 'null'],
              },
              moved: {
                type: 'boolean',
              },
              note: {
                type: ['string', 'null'],
              },
            },
          },
        },
        moved: {
          type: 'array',
          maxItems: 60,
          items: {
            $ref: '#/$defs/metric',
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
        metric: {
          type: 'object',
          additionalProperties: false,
          required: [
            'metric',
            'unit',
            'value',
            'previous',
            'change',
            'changePct',
            'avg4',
            'moved',
            'note',
          ],
          properties: {
            metric: {
              type: 'string',
            },
            unit: {
              type: 'string',
            },
            value: {
              type: 'number',
            },
            previous: {
              type: ['number', 'null'],
            },
            change: {
              type: ['number', 'null'],
            },
            changePct: {
              type: ['number', 'null'],
            },
            avg4: {
              type: ['number', 'null'],
            },
            moved: {
              type: 'boolean',
            },
            note: {
              type: ['string', 'null'],
            },
          },
        },
      },
    },
  },
  safety: ['person', 'files', 'structured'],
});
