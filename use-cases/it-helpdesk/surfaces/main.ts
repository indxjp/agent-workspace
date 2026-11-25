import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'it-helpdesk',
  title: 'ITヘルプデスク / IT helpdesk',
  layout: 'side',
  parts: {
    greeting:
      'パスワード・VPN・プリンターの困りごとを聞かせてください。ナレッジベースの手順で答えます。Tell me about a password, VPN or printer problem: I answer with the knowledge base steps.',
    suggestedPrompts: [
      'VPNに接続しようとするとエラー E-412 が出ます',
      'The VPN shows error E-412 when I try to connect',
      'パスワードを忘れました。どうすればいいですか？',
      'I forgot my password. What should I do?',
    ],
    disclaimer:
      '回答はナレッジベースの記事だけに基づきます。パスワードはチャットに書かないでください。Answers come only from the knowledge base; never write a password in the chat.',
    toolTrace: 'collapsed',
    feedback: true,
  },
  // Search hits render as cards. The key is the tool's bare name: a run's engine prefix is ignored.
  toolResults: { search_files: 'card' },
});
