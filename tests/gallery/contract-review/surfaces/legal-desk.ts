import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'legal-desk',
  agent: 'contract-review',
  title: '契約書レビュー',
  // A full page: a risk table with 修正文案 is too wide for a side panel.
  layout: 'page',
  parts: {
    greeting:
      '契約書ドラフトを契約管理画面でアップロードし、ファイル名を入力してください。審査基準に照らしてリスク表を作ります。',
    suggestedPrompts: [
      'contracts/業務委託契約書_株式会社ミナトシステムズ案.docx をレビューして',
      '第6条の修正文案を、上限を委託料12か月分にして書き直して',
      'PB-04 の審査基準を説明して',
    ],
    disclaimer: 'リスク表は判断材料です。締結の可否は法務部が判断します。',
    toolTrace: 'collapsed',
    history: true,
    feedback: true,
  },
});
