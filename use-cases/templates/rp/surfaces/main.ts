import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: '__slug__',
  title: 'レポート / Report',
  layout: 'side',
  parts: {
    greeting: '今日のレポートを作成します。 / I write today’s report.',
    suggestedPrompts: [
      '今日のレポートを作成して',
      'Write today’s report',
      '昨日のレポートを作成して',
      'Write yesterday’s report',
    ],
  },
});
