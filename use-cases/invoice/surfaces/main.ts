import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'invoice',
  title: '請求書照合 / Invoice matching',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '届いた請求書を添付するか、invoice/inbox のファイルを指定してください。発注書・納品書と明細ごとに突き合わせます。 / Attach the invoice you received or name a file in invoice/inbox, and I will match each line with the purchase order and delivery note.',
    suggestedPrompts: [
      'invoice/inbox/請求書_ミサゴ工業_INV-M-24117.md を照合して',
      'Match invoice/inbox/請求書_ミサゴ工業_INV-M-24117.md',
      'MATCH-03 の数量の照合ルールを説明して',
    ],
    disclaimer:
      '判定は照合ルールにもとづく判断材料で、会計・税務の助言ではありません。支払うかどうかは担当者が決めます。 / The verdicts follow your matching rules and are not accounting or tax advice. A person decides whether to pay.',
    toolTrace: 'collapsed',
    history: true,
  },
});
