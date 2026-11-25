import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'supplier',
  area: 'mfg',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/supplier',
  name: {
    ja: '仕入先品質管理',
    en: 'Supplier quality',
  },
  summary: {
    ja: '受入検査とクレームの履歴から、仕入先ごとの品質の傾向を報告する。',
    en: 'Reports quality trends per supplier from inspections and claims.',
  },
  demo: {
    agent: 'supplier',
    prompts: [
      {
        ja: '2026年11月の仕入先品質レポートを作成して',
        en: 'Write the supplier quality report for November 2026',
      },
      {
        ja: 'ヒサメ樹脂の2026年6月から11月の不良率の推移とクレームを教えて',
        en: 'Show Hisame Resin’s defect rate from June to November 2026 and its claims',
      },
    ],
    moment: {
      ja: '自社の基準で要注意の仕入先が理由と出典つきで挙がり、仕入先別の不良率と全体の推移が描かれ、保存は承認を待つ。',
      en: 'Suppliers on watch under the company’s rules are listed with reasons and sources, each supplier’s rate and the overall trend are charted, and the save waits for approval.',
    },
    data: {
      ja: '架空の品質管理システムの受入検査とクレームのCSV、仕入先品質の基準',
      en: 'a fictional quality system’s incoming inspection and claims CSVs, and the supplier quality rules',
    },
    seed: [{ collection: 'supplier', from: 'data' }],
    check: { tools: ['search_files'], approval: 'Write' },
    // The trigger's outputSchema, as the suggested eval case asks for it; the surface charts suppliers and trend.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['month', 'suppliers', 'trend', 'savedTo'],
      properties: {
        month: { type: 'string' },
        suppliers: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['supplier', 'defectPpm', 'status', 'reasons', 'sources'],
            properties: {
              supplier: { type: 'string' },
              defectPpm: { type: 'integer' },
              status: { type: 'string', enum: ['watch', 'ok'] },
              reasons: { type: 'array', items: { type: 'string' } },
              sources: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        trend: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['month', 'defectPpm'],
            properties: { month: { type: 'string' }, defectPpm: { type: 'integer' } },
          },
        },
        savedTo: { type: 'string' },
      },
    },
  },
  safety: ['approval', 'trigger', 'structured', 'files'],
});
