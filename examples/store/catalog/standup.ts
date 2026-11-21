import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'standup',
  area: 'collab',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/standup',
  name: {
    ja: '朝会まとめ',
    en: 'Stand-up digest',
  },
  summary: {
    ja: 'タスク・コミット・チャットから、人ごとに昨日・今日・困りごとをまとめる。',
    en: 'Sums up yesterday, today and blockers per person from tasks, commits and chat.',
  },
  demo: {
    agent: 'standup',
    prompts: [
      {
        ja: '2026-11-25 の朝会まとめを作成して',
        en: 'Write the stand-up digest for 2026-11-25',
      },
      {
        ja: '2026-11-24 の朝会まとめを作成して',
        en: 'Write the stand-up digest for 2026-11-24',
      },
    ],
    moment: {
      ja: '人ごとの昨日・今日・困りごとが出典つきで並び、人の評価はせず、保存は承認を待つ。',
      en: 'Each person’s yesterday, today and blockers appear with sources, nobody is evaluated, and the save waits for approval.',
    },
    data: {
      ja: '架空のチームのタスク・コミット・チャットの記録',
      en: 'a fictional team’s task, commit and chat records',
    },
    seed: [{ collection: 'standup', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'Write' },
  },
  safety: ['approval', 'trigger', 'structured', 'files'],
});
