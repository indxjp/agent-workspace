import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'support',
  agent: 'customer-inquiry',
  title: 'お客様サポート',
  layout: 'dock',
  parts: {
    greeting:
      'みどり生活館オンラインストアです。ご注文や配送、返品について、お気軽にご質問ください。',
    suggestedPrompts: [
      '注文した商品がまだ届きません',
      '返品の受付期間を教えてください',
      'ポイントの有効期限はいつまでですか',
      '定期便を1回お休みしたい',
    ],
    disclaimer:
      'AIがお答えしています。返金・ご登録情報の変更・ご本人確認が必要なお手続きは、担当者におつなぎします。',
    // The trace would show tool inputs, including the customer token: never show it to a visitor.
    toolTrace: 'hidden',
    history: true,
    feedback: true,
  },
  allowedOrigins: ['https://www.example.co.jp'],
  limits: { turnsPerConversation: 30 },
});
