import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'multilingual',
  area: 'support',
  status: 'soon',
  wave: 3,
  name: {
    ja: '多言語返信',
    en: 'Multilingual replies',
  },
  summary: {
    ja: '英語・中国語などの問い合わせに日本語の要約を付け、返信を相手の言語で作る。',
    en: "Adds a Japanese summary to foreign-language enquiries and drafts the reply in the customer's language.",
  },
});
