import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'glossary',
  area: 'knowledge',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/glossary',
  name: {
    ja: '用語チェック',
    en: 'Terminology checker',
  },
  summary: {
    ja: '文書の用語を社内用語集と照らし、用語ごとに推奨語を示す。',
    en: 'Checks the terms in a document against your glossary and gives the preferred term for each.',
  },
  demo: {
    agent: 'glossary',
    prompts: [
      {
        ja: 'glossary/inbox/シギノ・リンク_かんたん操作ガイド_草稿.md の用語をチェックして',
        en: 'Check the terms in glossary/inbox/シギノ・リンク_かんたん操作ガイド_草稿.md',
      },
      {
        ja: 'TERM-05 のアラートの使い分けを説明して',
        en: 'Explain when TERM-05 allows "alarm" instead of "alert".',
      },
    ],
    moment: {
      ja: '文書を渡すと、用語集の項目ごとに判定と推奨語が並び、レポートの保存は承認を待つ。',
      en: 'Hand over a document; each glossary term gets a verdict and the preferred term, and the report waits for approval.',
    },
    data: {
      ja: '架空の製品ガイドとリリースノートの草稿・社内用語集',
      en: 'fictional product guide and release note drafts, a company glossary',
    },
    seed: [{ collection: 'glossary', from: 'data/ja' }],
    check: { tools: ['Read'], approval: 'Write' },
  },
  safety: ['person', 'approval', 'files'],
});
