import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'code-review',
  area: 'it',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/code-review',
  name: {
    ja: 'コードレビュー',
    en: 'Code reviewer',
  },
  summary: {
    ja: 'パッチをチームのコーディング規約に照らし、ルールごとに該当行と修正案を示す。',
    en: 'Reviews a patch against your coding standard, rule by rule, with the line and a fix.',
  },
  demo: {
    agent: 'code-review',
    prompts: [
      {
        ja: 'code-review/inbox/0001-member-search.patch をコーディング規約でレビューして',
        en: 'Review code-review/inbox/0001-member-search.patch against the coding standard',
      },
      {
        ja: 'CS-03 のSQLのルールを説明して',
        en: 'Explain the CS-03 rule on SQL.',
      },
    ],
    moment: {
      ja: 'パッチを渡すと、規約のルールごとに判定と該当行と修正案が並び、レビューの保存は承認を待つ。',
      en: 'Hand over a patch; each rule gets a verdict, the line and a fix, and the review waits for approval.',
    },
    data: {
      ja: '架空のパッチ2本・チームのコーディング規約',
      en: '2 fictional patches, a team coding standard',
    },
    seed: [{ collection: 'code-review', from: 'data/ja' }],
    check: { tools: ['Read'], approval: 'Write' },
  },
  safety: ['person', 'approval', 'files'],
});
