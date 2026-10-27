import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'legal-desk',
  agent: 'contract-review',
  title: '契約書レビュー',
  // A full page: a risk table with 修正文案 is too wide for a side panel.
  layout: 'page',
  parts: {
    attachments: true,
    greeting: '契約書ドラフト（Word）を添付してください。審査基準に照らしてリスク表を作ります。',
    suggestedPrompts: [
      '添付の契約書をレビューして',
      '第6条の修正文案を、上限を委託料12か月分にして書き直して',
      'PB-04 の審査基準を説明して',
    ],
    disclaimer: 'リスク表は判断材料です。締結の可否は法務部が判断します。',
    toolTrace: 'collapsed',
    history: true,
    feedback: true,
  },
});
