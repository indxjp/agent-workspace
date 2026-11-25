import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'customer-inquiry',
  area: 'support',
  status: 'live',
  wave: 1,
  kind: 'agent',
  source: 'tests/gallery/customer-inquiry',
  name: {
    ja: '問い合わせ対応',
    en: 'Customer inquiry agent',
  },
  summary: {
    ja: '問い合わせメールを分類し、マニュアルと過去の対応から返信案を作る。送信は担当者の確認後。',
    en: 'Sorts enquiry emails and drafts replies from manuals and past answers. A person confirms before sending.',
  },
  demo: {
    agent: 'customer-inquiry',
    prompts: [
      {
        ja: '商品が届いてから何日以内なら返品できますか？',
        en: 'How many days after delivery can I still return an item?',
      },
      {
        ja: '先週返品した商品の代金をすぐ返金してください',
        en: 'Please refund the item I returned last week right away.',
      },
    ],
    moment: {
      ja: '問い合わせに、FAQの記載をもとにした答えを返す。',
      en: 'An enquiry gets an answer grounded in the FAQ.',
    },
    data: {
      ja: 'FAQ3本',
      en: '3 FAQ articles',
    },
    seed: [{ collection: 'faq', from: 'data/faq' }],
    check: { tools: ['search_files'], approval: null },
  },
  safety: ['person', 'trigger'],
  next: {
    source: 'use-cases/customer-inquiry',
    demo: {
      agent: 'customer-inquiry',
      prompts: [
        {
          ja: '商品が届いてから何日以内なら返品できますか？',
          en: 'How many days after delivery can I still return an item?',
        },
        {
          ja: '先週返品した商品の代金をすぐ返金してください',
          en: 'Please refund the item I returned last week right away.',
        },
      ],
      moment: {
        ja: '問い合わせに、FAQの記載をもとにした返信の下書きができ、担当者へのタスクの登録は承認を待つ。',
        en: 'An enquiry gets a reply draft grounded in the FAQ, and the task for the owner waits for approval.',
      },
      data: {
        ja: 'FAQ3本・担当者の一覧・架空の問い合わせ',
        en: '3 FAQ articles, the owners list and fictional enquiries',
      },
      seed: [{ collection: 'customer-inquiry', from: 'data/ja' }],
      check: { tools: ['search_files'], approval: 'create_task' },
    },
  },
});
