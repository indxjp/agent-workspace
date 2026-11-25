import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'churn',
  area: 'analytics',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/churn',
  name: {
    ja: '解約予兆分析',
    en: 'Churn signals',
  },
  summary: {
    ja: '利用状況の変化から解約の兆候がある顧客を見つけ、どの兆候が出ているかを示す。',
    en: 'Finds customer accounts showing signs of leaving in their usage, and which signs.',
  },
  demo: {
    agent: 'churn',
    prompts: [
      {
        ja: '利用状況_2026年6月-11月.csv で、解約の兆候がある顧客と、その兆候を示して',
        en: 'In account-usage-2026-06-to-11.csv, show the customer accounts with signs of leaving and the signs',
      },
      {
        ja: '利用状況_2026年6月-11月.csv で、兆候が1つでもある顧客をすべて挙げて',
        en: 'In account-usage-2026-06-to-11.csv, list every customer account with at least one sign',
      },
    ],
    moment: {
      ja: 'スクリプトが顧客ごとの利用状況をその顧客の過去の水準と比べて決まったルールで兆候を判定し、兆候のある顧客とその兆候が、グラフと計算どおりの数値で示される。',
      en: 'A script compares each customer account’s usage with its own past level and finds the signs by fixed rules, and the accounts with signs and the signs themselves show in a chart with exactly its numbers.',
    },
    data: {
      ja: '架空のクラウドサービスの顧客別・月別の利用状況（6か月分）と、備考付きの同じデータのCSV',
      en: 'CSVs of a fictional cloud service’s monthly usage by customer account over six months, and the same data with a note column',
    },
    seed: [{ collection: 'churn', from: 'data' }],
    check: { tools: ['run_skill_script'], approval: null },
    // The suggested eval case's schema (evals/churn.yaml); the surface charts it.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'month',
        'baseline',
        'signsAtLeast',
        'atRisk',
        'accounts',
        'notAssessed',
        'commentary',
      ],
      properties: {
        month: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}$',
        },
        baseline: {
          type: 'integer',
        },
        signsAtLeast: {
          type: 'integer',
        },
        atRisk: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'accountId',
              'accountName',
              'seats',
              'activeUsers',
              'logins',
              'tickets',
              'adoption',
              'baseActive',
              'baseLogins',
              'baseTickets',
              'activeChange',
              'loginChange',
              'signs',
              'signCount',
            ],
            properties: {
              accountId: {
                type: 'string',
              },
              accountName: {
                type: 'string',
              },
              seats: {
                type: 'integer',
              },
              activeUsers: {
                type: 'integer',
              },
              logins: {
                type: 'integer',
              },
              tickets: {
                type: 'integer',
              },
              adoption: {
                type: 'number',
              },
              baseActive: {
                type: 'number',
              },
              baseLogins: {
                type: 'number',
              },
              baseTickets: {
                type: 'number',
              },
              activeChange: {
                type: ['number', 'null'],
              },
              loginChange: {
                type: ['number', 'null'],
              },
              signs: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
              signCount: {
                type: 'integer',
              },
            },
          },
        },
        accounts: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'accountId',
              'accountName',
              'seats',
              'activeUsers',
              'logins',
              'tickets',
              'adoption',
              'baseActive',
              'baseLogins',
              'baseTickets',
              'activeChange',
              'loginChange',
              'signs',
              'signCount',
            ],
            properties: {
              accountId: {
                type: 'string',
              },
              accountName: {
                type: 'string',
              },
              seats: {
                type: 'integer',
              },
              activeUsers: {
                type: 'integer',
              },
              logins: {
                type: 'integer',
              },
              tickets: {
                type: 'integer',
              },
              adoption: {
                type: 'number',
              },
              baseActive: {
                type: 'number',
              },
              baseLogins: {
                type: 'number',
              },
              baseTickets: {
                type: 'number',
              },
              activeChange: {
                type: ['number', 'null'],
              },
              loginChange: {
                type: ['number', 'null'],
              },
              signs: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
              signCount: {
                type: 'integer',
              },
            },
          },
        },
        notAssessed: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['accountId', 'accountName'],
            properties: {
              accountId: {
                type: 'string',
              },
              accountName: {
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
