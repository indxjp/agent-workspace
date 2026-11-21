import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'faq-bot',
  area: 'support',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/faq-bot',
  name: {
    ja: 'FAQチャット',
    en: 'FAQ chat',
  },
  summary: {
    ja: 'ヘルプセンターの記事から、出典付きでお客様の質問に答えるFAQチャット。',
    en: 'An FAQ chat that answers customers from your help-center articles and cites each one.',
  },
  demo: {
    agent: 'faq-bot',
    prompts: [
      {
        ja: '定期便を次回だけお休みできますか？',
        en: 'Can I skip just the next delivery of my subscription?',
      },
      {
        ja: '開封したコーヒー豆は返品できますか？',
        en: 'Can I return beans I have already opened?',
      },
    ],
    moment: {
      ja: 'お客様の質問に、ヘルプセンターの記事の出典付きで答え、記事にないことは窓口に引き継ぐ。',
      en: 'A customer asks; the answer cites the help-center article, and anything not covered goes to the support team.',
    },
    data: {
      ja: '架空のオンラインショップのヘルプセンター記事のエクスポート',
      en: "a fictional online shop's help-center article export",
    },
    seed: [{ collection: 'faq-bot', from: 'data' }],
    check: { tools: ['search_files'], approval: null },
  },
  safety: ['files'],
});
