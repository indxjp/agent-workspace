import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'faq-bot',
  title: 'FAQチャット / FAQ chat',
  layout: 'side',
  parts: {
    greeting:
      '配送・返品・定期便・お支払いについてご質問ください。ヘルプセンターの記事を示して答えます。Ask about shipping, returns, subscriptions or payment: every answer cites the help-center article.',
    suggestedPrompts: [
      '定期便を次回だけお休みできますか？',
      'Can I return beans I have already opened?',
      '送料はいくらですか？',
    ],
    disclaimer:
      '回答はヘルプセンターの記事だけに基づきます。ご注文ごとの状況はお問い合わせフォームへ。Answers come only from the help center; ask about your own order through the contact form.',
    toolTrace: 'collapsed',
    feedback: true,
  },
  // Search hits render as cards. The key is the tool's bare name: a run's engine prefix is ignored.
  toolResults: { search_files: 'card' },
});
