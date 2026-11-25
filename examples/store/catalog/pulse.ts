import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'pulse',
  area: 'hr',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/pulse',
  name: {
    ja: '社員サーベイ分析',
    en: 'Engagement survey',
  },
  summary: {
    ja: 'サーベイの結果を部署別に分析し、打ち手の案を作る。',
    en: 'Analyses survey results by team and proposes actions.',
  },
  demo: {
    agent: 'pulse',
    prompts: [
      {
        ja: '社員サーベイ_2026年11月.csv を部署別に分析して、打ち手の案を出して',
        en: 'Analyse engagement-survey-2026-11.csv by team and suggest actions',
      },
      {
        ja: '社員サーベイ_2026年11月.csv を 社員サーベイ_2026年5月.csv と比べて、下がった項目を挙げて',
        en: 'Compare engagement-survey-2026-11.csv with engagement-survey-2026-05.csv and list what dropped',
      },
    ],
    moment: {
      ja: 'スクリプトがサーベイを一定の人数以上の部署だけで集計し、部署別・設問別の好意的な回答の割合と前回からの変化が計算どおりの数値で示され、少人数の部署は数値を出さずに伏せられる。',
      en: 'A script tallies the survey only for teams with enough respondents, and the favourable share by team and by question, with the change since the last survey, show exactly its numbers, while a small team is held back with no figure.',
    },
    data: {
      ja: '架空の会社の社員サーベイの回答（2回分、部署と5つの設問）と、コメント付きの再提出分のCSV',
      en: 'CSVs of a fictional company’s engagement survey responses (two rounds, team and five questions) and a resubmitted round with comments',
    },
    seed: [{ collection: 'pulse', from: 'data' }],
    check: { tools: ['run_skill_script'], approval: null },
    // The suggested eval case's schema (evals/pulse.yaml); the surface charts it.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'period',
        'previousPeriod',
        'responses',
        'minGroup',
        'teams',
        'questions',
        'drops',
        'heldBack',
        'commentary',
      ],
      properties: {
        period: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}$',
        },
        previousPeriod: {
          type: ['string', 'null'],
        },
        responses: {
          type: 'integer',
        },
        minGroup: {
          type: 'integer',
        },
        teams: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['team', 'responses', 'favourable', 'previous', 'change'],
            properties: {
              team: {
                type: 'string',
              },
              responses: {
                type: 'integer',
              },
              favourable: {
                type: 'number',
              },
              previous: {
                type: ['number', 'null'],
              },
              change: {
                type: ['number', 'null'],
              },
            },
          },
        },
        questions: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['question', 'favourable', 'previous', 'change'],
            properties: {
              question: {
                type: 'string',
              },
              favourable: {
                type: 'number',
              },
              previous: {
                type: ['number', 'null'],
              },
              change: {
                type: ['number', 'null'],
              },
            },
          },
        },
        drops: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['team', 'question', 'favourable', 'previous', 'change'],
            properties: {
              team: {
                type: 'string',
              },
              question: {
                type: 'string',
              },
              favourable: {
                type: 'number',
              },
              previous: {
                type: ['number', 'null'],
              },
              change: {
                type: ['number', 'null'],
              },
            },
          },
        },
        heldBack: {
          type: 'array',
          items: {
            type: 'string',
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
