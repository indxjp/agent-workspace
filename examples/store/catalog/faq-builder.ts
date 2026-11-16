import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'faq-builder',
  area: 'knowledge',
  status: 'soon',
  wave: 3,
  name: {
    ja: 'FAQ自動作成',
    en: 'FAQ builder',
  },
  summary: {
    ja: '問い合わせの履歴から、よくある質問と回答案を作る。',
    en: 'Builds FAQs and draft answers from enquiry history.',
  },
});
