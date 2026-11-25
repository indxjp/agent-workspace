import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'returns',
  title: '返品・交換受付 / Returns desk',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '返品の申込を添付するか、returns/inbox のファイルを指定してください。返品規程と注文データに照らして、項目ごとに判定します。 / Attach a return request or name a file in returns/inbox, and I will check it against the return policy and the order record, item by item.',
    suggestedPrompts: [
      'returns/inbox/R-1102_返品申込.md を返品規程に照らして確認して',
      'Check returns/inbox/R-1102_返品申込.md against the return policy',
      'RET-03 の返品できない商品の基準を説明して',
    ],
    disclaimer:
      '判定は判断材料です。返品・返金を受け付けるかどうかは担当者が決めます。 / The verdicts are input only. A person decides whether to accept a return and refund.',
    toolTrace: 'collapsed',
    history: true,
  },
});
