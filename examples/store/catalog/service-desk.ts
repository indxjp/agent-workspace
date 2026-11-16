import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'service-desk',
  area: 'support',
  status: 'live',
  wave: 1,
  kind: 'app',
  source: 'examples/service-desk',
  name: {
    ja: 'AIサービスデスク',
    en: 'Service desk',
  },
  summary: {
    ja: 'チケットの受付・分類・優先度・担当の割り当てまでをエージェントが行うヘルプデスク。',
    en: 'A help desk where the agent takes in tickets, sorts them, sets priority and assigns them.',
  },
  demo: {
    agent: 'triage',
    prompts: [
      {
        ja: '新着チケット「会議室のプロジェクターにPCが映らない」の優先度と担当を決めて、役に立つナレッジ記事を教えて',
        en: `For the new ticket "Laptop won't show on the meeting room projector", set the priority and owner and point me to a helpful knowledge article.`,
      },
      {
        ja: '新着のチケットを優先度の高い順に並べて',
        en: 'List the new tickets, highest priority first.',
      },
    ],
    moment: {
      ja: 'チケットを起票すると、エージェントが優先度と担当を決め、役に立つナレッジ記事を答えで示す。',
      en: 'File a ticket; the agent sets priority and owner and names the helpful knowledge article in its answer.',
    },
    data: {
      ja: 'チケット12件・ナレッジ記事8本',
      en: '12 tickets, 8 knowledge articles',
    },
    seed: [],
    records: 'tests/sample-data',
    check: { tools: ['kb_article_search', 'ticket_update'], approval: null },
  },
  safety: ['person', 'trigger', 'structured'],
});
