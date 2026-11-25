import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'it-helpdesk',
  area: 'it',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/it-helpdesk',
  name: {
    ja: 'ITヘルプデスク',
    en: 'IT helpdesk',
  },
  summary: {
    ja: 'パスワード・VPN・プリンターなどの質問に手順で答える。',
    en: 'Answers password, VPN and printer questions step by step.',
  },
  demo: {
    agent: 'it-helpdesk',
    prompts: [
      {
        ja: 'VPNに接続しようとするとエラー E-412 が出ます',
        en: 'The VPN shows error E-412 when I try to connect',
      },
      {
        ja: 'パスワードを忘れました。どうすればいいですか？',
        en: 'I forgot my password. What should I do?',
      },
    ],
    moment: {
      ja: 'ITの困りごとを伝えると、ナレッジベースの記事の出典がついた手順が返り、記事にないことはヘルプデスクに引き継ぐ。',
      en: 'Describe an IT problem; the steps come back citing the knowledge base article, and anything not covered goes to the helpdesk.',
    },
    data: {
      ja: '架空の会社のヘルプデスクのナレッジベース記事のエクスポート',
      en: "a fictional company's helpdesk knowledge base article export",
    },
    seed: [{ collection: 'it-helpdesk', from: 'data' }],
    check: { tools: ['search_files'], approval: null },
  },
  safety: ['files'],
});
