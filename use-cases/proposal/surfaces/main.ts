import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'proposal',
  title: '提案書ドラフト / Proposal drafter',
  layout: 'page',
  parts: {
    greeting:
      '打ち合わせメモと要件一覧から、製品資料と導入事例をもとに提案書の構成を PowerPoint で作ります。書き出す前に承認をお願いします。 / From your meeting notes and the requirements list, I draft a proposal outline as a PowerPoint deck from your product sheets and case studies, and ask for your approval before writing it.',
    suggestedPrompts: [
      'ヒバリノ精機の打ち合わせメモと要件一覧から提案書を作成して',
      'Draft the proposal for Hibarino Seiki from the meeting notes and requirements',
      'ヒバリノ精機向けの提案書の構成だけを示して',
    ],
    disclaimer:
      '下書きです。内容と費用は担当者が確認してから提出します。 / A draft: a person checks the content and the cost before it goes to the customer.',
    toolTrace: 'collapsed',
    history: true,
  },
});
