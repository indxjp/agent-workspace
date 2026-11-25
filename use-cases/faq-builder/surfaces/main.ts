import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'faq-builder',
  title: 'FAQ自動作成 / FAQ builder',
  layout: 'page',
  parts: {
    greeting:
      '問い合わせ履歴と製品のガイドから、よくある質問と回答案を Word で作ります。書き出す前に承認をお願いします。 / From the enquiry history and the product guides, I draft an FAQ as a Word document, and ask for your approval before writing it.',
    suggestedPrompts: [
      '10月の問い合わせ履歴からFAQを作成して',
      'Draft the FAQ from the October enquiry history',
      '料金・契約の問い合わせだけでFAQを作成して',
      'Draft an FAQ from the pricing and contract enquiries only',
    ],
    disclaimer:
      '下書きです。公開の前にサポート担当者が確認します。 / A draft: the support team checks it before it is published.',
    toolTrace: 'collapsed',
    history: true,
  },
});
