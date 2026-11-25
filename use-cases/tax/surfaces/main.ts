import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'tax',
  title: '税務チェック / Tax check',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '届いた請求書を添付するか、tax/inbox のファイルを指定してください。登録番号・税率の記載・税区分コードなどを、自社の経理ルールと仕訳入力データに照らします。 / Attach a supplier invoice or name a file in tax/inbox, and I will check its registration number, tax rates and tax codes against your own accounting rules and the entry typed for it.',
    suggestedPrompts: [
      'tax/inbox/請求書_カケス文具_KK-1187.md を社内の経理ルールに照らしてチェックして',
      'Check tax/inbox/請求書_カケス文具_KK-1187.md against our accounting rules',
      'tax/inbox/請求書_カケス文具_KK-1187.md の仕訳の税区分コードが社内の表と合っているか、TAX-03 だけ確かめて',
      'Check only TAX-03: do the entry tax codes for tax/inbox/請求書_カケス文具_KK-1187.md match our table?',
    ],
    disclaimer:
      '判定は自社の経理ルールにもとづく判断材料で、税務の助言ではありません。計上や支払いはしません。計上してよいかは経理部が決めます。 / The verdicts follow your own accounting rules and are not tax advice. It never books or pays; the accounting team decides.',
    toolTrace: 'collapsed',
    history: true,
  },
});
