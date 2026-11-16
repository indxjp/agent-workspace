import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'wiki',
  area: 'knowledge',
  status: 'live',
  wave: 1,
  kind: 'app',
  source: 'examples/wiki',
  name: {
    ja: 'AI付き社内Wiki',
    en: 'Wiki with assistant',
  },
  summary: {
    ja: 'ページを書く・探す・要約する。エージェントが既存のページを踏まえて下書きする。',
    en: 'Write, find and summarize pages. The agent drafts with the existing pages in mind.',
  },
  demo: {
    agent: 'writer',
    prompts: [
      {
        ja: '新人向けに、経費精算のやり方を既存のページをもとに1ページにまとめて',
        en: 'Write one page on expenses for new joiners, based on the existing pages.',
      },
      {
        ja: '出張申請の流れを書いたページを探して、要点を教えて',
        en: 'Find the page on business trip requests and give me the key points.',
      },
    ],
    moment: {
      ja: '「経費精算のやり方をまとめて」と頼むと、既存ページを引用した新しいページの下書きができる。',
      en: 'Ask "write up how expenses work" and get a new page draft that quotes existing pages.',
    },
    data: {
      ja: 'スペース3つ・ページ12枚',
      en: '3 spaces, 12 pages',
    },
    seed: [],
    records: 'tests/sample-data',
    check: { tools: ['page_search', 'page_create'], approval: null },
  },
  safety: ['person'],
});
