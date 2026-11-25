import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'lead-priority',
  area: 'sales',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/lead-priority',
  name: {
    ja: 'リード優先度づけ',
    en: 'Lead prioritizer',
  },
  summary: {
    ja: '問い合わせや展示会のリストを読み、先に連絡すべきリードを理由付きで並べる。',
    en: 'Reads enquiry and event lists and ranks which leads to call first, with reasons.',
  },
  demo: {
    agent: 'lead-priority',
    prompts: [
      {
        ja: 'リード一覧_2026年11月.csv のリードを、先に連絡すべき順に並べて',
        en: 'Rank the leads in leads-2026-11.csv in the order to contact them',
      },
      {
        ja: 'リード一覧_2026年11月.csv で、展示会から来たリードだけを優先順に並べて',
        en: 'In leads-2026-11.csv, rank only the leads that came from events',
      },
    ],
    moment: {
      ja: 'リードのCSVからスクリプトが決まった配点で点数を計算し、連絡する順と点数の内訳がグラフとともに計算どおりに示される。人は順位づけしない。',
      en: 'A script scores each lead in the CSV by fixed points, and the order to contact them and what makes up each score show exactly its numbers, with a chart. No person is ranked.',
    },
    data: {
      ja: '架空の会社からの引き合いをまとめたリード一覧のCSVと、備考付きの展示会リードの追加分',
      en: 'A lead list CSV of enquiries from fictional companies, and an additional event-lead list with notes',
    },
    seed: [{ collection: 'lead-priority', from: 'data' }],
    check: { tools: ['run_skill_script'], approval: null },
    // The suggested eval case's schema (evals/lead-priority.yaml); the surface charts leads and sources.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['asOf', 'source', 'count', 'leads', 'sources', 'commentary'],
      properties: {
        asOf: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        },
        source: {
          type: ['string', 'null'],
        },
        count: {
          type: 'integer',
        },
        leads: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'rank',
              'leadId',
              'company',
              'industry',
              'source',
              'daysSinceContact',
              'score',
              'points',
              'code',
            ],
            properties: {
              rank: {
                type: 'integer',
              },
              leadId: {
                type: 'string',
              },
              company: {
                type: 'string',
              },
              industry: {
                type: 'string',
              },
              source: {
                type: 'string',
              },
              daysSinceContact: {
                type: 'integer',
              },
              score: {
                type: 'integer',
              },
              points: {
                type: 'object',
                additionalProperties: false,
                required: ['source', 'size', 'visits', 'recency'],
                properties: {
                  source: {
                    type: 'integer',
                  },
                  size: {
                    type: 'integer',
                  },
                  visits: {
                    type: 'integer',
                  },
                  recency: {
                    type: 'integer',
                  },
                },
              },
              code: {
                type: 'string',
              },
            },
          },
        },
        sources: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['source', 'leads', 'averageScore'],
            properties: {
              source: {
                type: 'string',
              },
              leads: {
                type: 'integer',
              },
              averageScore: {
                type: 'number',
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
