import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'survey',
  area: 'support',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/survey',
  name: {
    ja: 'アンケート集計',
    en: 'Survey analyst',
  },
  summary: {
    ja: '自由記述を含むアンケートを集計し、要点をグラフ付きで報告する。',
    en: 'Tallies surveys, free text included, and reports the key points with charts.',
  },
  demo: {
    agent: 'survey',
    prompts: [
      {
        ja: 'アンケート回答_2026年10月-11月.csv で2026年11月の回答を集計して',
        en: 'Tally the November 2026 responses in survey-responses-2026-10-to-11.csv',
      },
      {
        ja: 'アンケート回答_2026年10月-11月.csv で2026年10月の満足度を窓口別に比べて',
        en: 'Compare satisfaction by channel for October 2026 in survey-responses-2026-10-to-11.csv',
      },
    ],
    moment: {
      ja: 'スクリプトがアンケートの回答を窓口ごとに一定数以上のまとまりだけで集計し、設問別の好意的な回答の割合、NPS、窓口別のグラフが計算どおりの数値で示され、少なすぎる窓口は数値を出さずに伏せられる。',
      en: 'A script tallies the responses only in channels with enough responses, and the favourable share by question, the NPS and the chart by channel show exactly its numbers, while a channel with too few responses is held back with no figure.',
    },
    data: {
      ja: '架空のサポート窓口の顧客アンケートの回答（2か月分、自由記述付き）と、コメント付きの追加分のCSV',
      en: 'CSVs of a fictional support desk’s customer survey responses (two months, with comments) and a late batch with comments',
    },
    seed: [{ collection: 'survey', from: 'data' }],
    check: { tools: ['run_skill_script'], approval: null },
    // The suggested eval case's schema (evals/survey.yaml); the surface charts it.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'month',
        'responses',
        'minGroup',
        'questions',
        'nps',
        'channels',
        'heldBack',
        'commentary',
      ],
      properties: {
        month: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}$',
        },
        responses: {
          type: 'integer',
        },
        minGroup: {
          type: 'integer',
        },
        questions: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['question', 'mean', 'favourable'],
            properties: {
              question: {
                type: 'string',
              },
              mean: {
                type: 'number',
              },
              favourable: {
                type: 'number',
              },
            },
          },
        },
        nps: {
          type: 'object',
          additionalProperties: false,
          required: ['promoters', 'passives', 'detractors', 'score'],
          properties: {
            promoters: {
              type: 'integer',
            },
            passives: {
              type: 'integer',
            },
            detractors: {
              type: 'integer',
            },
            score: {
              type: 'number',
            },
          },
        },
        channels: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['channel', 'responses', 'overall', 'nps'],
            properties: {
              channel: {
                type: 'string',
              },
              responses: {
                type: 'integer',
              },
              overall: {
                type: 'number',
              },
              nps: {
                type: 'number',
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
