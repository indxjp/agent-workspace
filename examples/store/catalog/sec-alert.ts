import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'sec-alert',
  area: 'it',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/sec-alert',
  name: {
    ja: 'セキュリティアラート分析',
    en: 'Security alert triage',
  },
  summary: {
    ja: '検知アラートを重要度順に並べ、調査メモを付ける。',
    en: 'Ranks security alerts and adds investigation notes.',
  },
  demo: {
    agent: 'sec-alert',
    prompts: [
      {
        ja: 'アラート SEC-0501 を分析して、担当者に渡してください',
        en: 'Triage alert SEC-0501 and hand it to the analyst',
      },
      {
        ja: 'アラート SEC-0503 の重要度を決めて、調査メモを付けてください',
        en: 'Set the severity of alert SEC-0503 and add investigation notes',
      },
    ],
    moment: {
      ja: 'アラートを渡すと、重要度と担当者が決まって調査メモが付き、調査のタスクの登録は承認を待つ。',
      en: 'Hand over an alert; it sets the severity and owner and adds investigation notes, and the investigation task waits for approval.',
    },
    data: {
      ja: '架空のセキュリティアラート・資産一覧・既知の送信元・SOC の当番表・調査の手順書',
      en: 'Fictional security alerts, the asset list, known source addresses, the SOC roster and the playbooks',
    },
    seed: [{ collection: 'sec-alert', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'create_task' },
  },
  safety: ['person', 'approval', 'trigger', 'structured', 'files'],
});
