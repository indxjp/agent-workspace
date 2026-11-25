import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'okr',
  area: 'collab',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/okr',
  name: {
    ja: 'OKR進捗',
    en: 'OKR tracker',
  },
  summary: {
    ja: '各チームの数字を集め、目標に対する進み具合を報告する。',
    en: 'Collects team numbers and reports progress against goals.',
  },
  demo: {
    agent: 'okr',
    prompts: [
      {
        ja: '2026-11-20 のチェックインからOKR進捗レポートを作成して',
        en: 'Write the OKR progress report from the 2026-11-20 check-ins',
      },
      {
        ja: '2026-11-20 のチェックインで、遅れている主要な結果と更新のない主要な結果を教えて',
        en: 'In the 2026-11-20 check-ins, which key results are behind or have no update?',
      },
    ],
    moment: {
      ja: '主要な結果ごとに進捗率が期待値と並び、遅れと更新のないものが出典つきで挙がり、人の評価はせず、保存は承認を待つ。',
      en: 'Each key result’s progress sits beside the expected progress, the ones behind or without an update are listed with sources, nobody is rated, and the save waits for approval.',
    },
    data: {
      ja: '架空のOKRツールから書き出したOKR一覧とチェックインのCSV',
      en: 'a fictional OKR tool’s export of the OKR list and check-ins as CSV',
    },
    seed: [{ collection: 'okr', from: 'data' }],
    check: { tools: ['search_files'], approval: 'Write' },
    // The trigger's outputSchema, as the suggested eval case asks for it; the surface charts keyResults.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['asOf', 'keyResults', 'savedTo'],
      properties: {
        asOf: { type: 'string' },
        keyResults: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'kr',
              'objective',
              'team',
              'progress',
              'expected',
              'status',
              'note',
              'sources',
            ],
            properties: {
              kr: { type: 'string' },
              objective: { type: 'string' },
              team: { type: 'string' },
              progress: { type: 'integer' },
              expected: { type: 'integer' },
              status: { type: 'string', enum: ['on_track', 'behind', 'no_update'] },
              note: { type: 'string' },
              sources: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        savedTo: { type: 'string' },
      },
    },
  },
  safety: ['person', 'approval', 'trigger', 'structured', 'files'],
});
