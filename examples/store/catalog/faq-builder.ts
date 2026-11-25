import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'faq-builder',
  area: 'knowledge',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/faq-builder',
  name: {
    ja: 'FAQ自動作成',
    en: 'FAQ builder',
  },
  summary: {
    ja: '問い合わせの履歴から、よくある質問と回答案を作る。',
    en: 'Builds FAQs and draft answers from enquiry history.',
  },
  demo: {
    agent: 'faq-builder',
    prompts: [
      {
        ja: '10月の問い合わせ履歴からFAQを作成して',
        en: 'Draft the FAQ from the October enquiry history',
      },
      {
        ja: '料金・契約の問い合わせだけでFAQを作成して',
        en: 'Draft an FAQ from the pricing and contract enquiries only',
      },
    ],
    moment: {
      ja: '問い合わせ履歴を渡すと、製品ガイドの出典付きでよくある質問と回答案の構成が出て、Word の書き出しが承認待ちになる。',
      en: 'Hand over the enquiry history; out comes an FAQ outline with each answer citing the product guide, and the Word file waits for approval.',
    },
    data: {
      ja: '架空の勤怠アプリの問い合わせ履歴（CSV）と製品ガイド・料金ページ・サポート窓口',
      en: "a fictional attendance app's enquiry history (CSV), product guide, pricing page and support page",
    },
    seed: [{ collection: 'faq-builder', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['approval', 'files', 'structured'],
});
