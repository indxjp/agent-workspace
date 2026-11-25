import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'daily-report',
  title: '生産日報まとめ / Production daily',
  layout: 'side',
  parts: {
    greeting:
      '各ラインの日報から、稼働率・生産数・不良数と課題を日報の数字のまま1枚にまとめます。保存の前に承認をお願いします。 / I put each line’s utilization, output, defects and issues on one page, with the figures as the line reports give them, and ask for your approval before saving.',
    suggestedPrompts: [
      '2026-11-24 の生産日報まとめを作成して',
      'Write the production daily for 2026-11-24',
      '2026-11-25 の生産日報まとめを作成して',
      'Write the production daily for 2026-11-25',
    ],
  },
});
