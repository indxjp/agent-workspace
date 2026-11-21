import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'screening-hr',
  area: 'hr',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/screening-hr',
  name: {
    ja: '書類選考サポート',
    en: 'Screening assistant',
  },
  summary: {
    ja: '募集要項に照らして応募書類の要点を整理する（合否は人が判断）。',
    en: 'Summarizes applications against the job description (a person decides).',
  },
  demo: {
    agent: 'screening-hr',
    prompts: [
      {
        ja: 'screening-hr/inbox/A-0412_職務経歴書.md を募集要項の要件ごとに整理して',
        en: 'Summarise screening-hr/inbox/A-0412_職務経歴書.md against the posted requirements',
      },
      {
        ja: 'REQ-03 の要件の判断の目安を説明して',
        en: 'Explain how the REQ-03 requirement is judged.',
      },
    ],
    moment: {
      ja: '応募書類を渡すと、要件ごとに「満たす・不明確・記載なし」と根拠の引用が並び、サマリーの保存は承認を待つ。',
      en: 'Hand over an application; each requirement gets met, unclear or not shown with a quote, and the summary waits for approval.',
    },
    data: {
      ja: '架空の応募書類2通・募集要項の要件',
      en: '2 fictional applications, the posted job requirements',
    },
    seed: [{ collection: 'screening-hr', from: 'data/ja' }],
    check: { tools: ['Read'], approval: 'Write' },
  },
  safety: ['person', 'approval', 'files'],
});
