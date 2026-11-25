import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'escalation',
  area: 'support',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/escalation',
  name: {
    ja: 'エスカレーション判定',
    en: 'Escalation triage',
  },
  summary: {
    ja: '重大度を判定し、必要なときだけ上長と技術チームにつなぐ。',
    en: 'Rates severity and pulls in managers and engineers only when needed.',
  },
  demo: {
    agent: 'escalation',
    prompts: [
      {
        ja: 'チケット TCK-2101 のエスカレーションを判定してください',
        en: 'Decide whether ticket TCK-2101 needs escalating',
      },
      {
        ja: 'チケット TCK-2103 を判定して、呼ぶ相手を決めてください',
        en: 'Triage ticket TCK-2103 and decide whom to pull in',
      },
    ],
    moment: {
      ja: 'チケットを渡すと、重要度と呼ぶ相手が決まり、エスカレーションのタスクの登録は承認を待つ。',
      en: 'Hand over a ticket; it sets the priority and whom to pull in, and the escalation task waits for approval.',
    },
    data: {
      ja: '架空の問い合わせチケット・お客様の契約プラン・今週のエスカレーション先',
      en: "Fictional support tickets, customer plans and this week's escalation contacts",
    },
    seed: [{ collection: 'escalation', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'create_task' },
  },
  safety: ['person', 'approval', 'trigger', 'structured', 'files'],
});
