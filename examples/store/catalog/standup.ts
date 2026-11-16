import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'standup',
  area: 'collab',
  status: 'soon',
  wave: 2,
  name: {
    ja: '朝会まとめ',
    en: 'Stand-up digest',
  },
  summary: {
    ja: 'チャンネルの書き込みから、昨日・今日・困りごとを集める。',
    en: 'Collects yesterday, today and blockers from the channel.',
  },
});
