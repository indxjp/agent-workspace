import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'standup',
  title: '朝会まとめ / Stand-up digest',
  layout: 'side',
  parts: {
    greeting:
      '毎朝、前の営業日のタスク・コミット・チャットから、人ごとに「昨日・今日・困りごと」をまとめます。作業だけをまとめ、人の評価はしません。保存の前に承認をお願いします。 / Each morning, I sum up yesterday, today and blockers for each person from the previous working day’s tasks, commits and chat. I sum up the work only and never evaluate people, and ask for your approval before saving.',
    suggestedPrompts: [
      '2026-11-25 の朝会まとめを作成して',
      'Write the stand-up digest for 2026-11-25',
      '2026-11-24 の朝会まとめを作成して',
      'Write the stand-up digest for 2026-11-24',
    ],
  },
});
