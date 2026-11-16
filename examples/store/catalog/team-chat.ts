import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'team-chat',
  area: 'collab',
  status: 'live',
  wave: 1,
  kind: 'app',
  source: 'examples/team-chat',
  name: {
    ja: 'AIチームチャット',
    en: 'Team chat',
  },
  summary: {
    ja: 'チャンネルでエージェントに頼める社内チャット。会話の要約や調べものを任せられる。',
    en: 'Team chat where you can ask an agent in the channel to summarize or look things up.',
  },
  demo: {
    agent: 'helper',
    prompts: [
      {
        ja: '#新製品 チャンネルの今週の議論をまとめて。決まったことと、まだ決まっていないことを分けて',
        en: 'Sum up this week in the #new-product channel, separating what was decided from what is still open.',
      },
      {
        ja: '#品質 チャンネルで最近出た話題を3つに絞って教えて',
        en: 'Give me the three main topics from the #quality channel lately.',
      },
    ],
    moment: {
      ja: 'チャンネルの議論をまとめて頼むと、決まったことと未決のことを分けて返す。',
      en: 'Ask for a channel summary; decided and still-open points come back separately.',
    },
    data: {
      ja: 'チャンネル5つ・メッセージ36件',
      en: '5 channels, 36 messages',
    },
    seed: [],
    records: 'tests/sample-data',
    check: { tools: ['message_list'], approval: null },
  },
  safety: ['person'],
});
