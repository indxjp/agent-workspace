import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'close',
  title: '月次決算サポート / Month-end close',
  layout: 'side',
  parts: {
    greeting:
      '決算作業の進み具合と、止まっている作業を担当者と理由つきで一覧にします。仕訳は計上せず、保存の前に承認をお願いします。 / I show how the close is going and list the stuck tasks with their owner and reason. I post no entries, and ask for your approval before saving.',
    suggestedPrompts: [
      '2026-12-03 時点の11月度の月次決算の進捗レポートを作成して',
      'Write the November close progress report as of 2026-12-03',
      '杉森さんの担当作業に絞って、2026-12-03 時点の11月度の月次決算の進捗レポートを作成して',
      'Write the November close progress report as of 2026-12-03 for Ren Sugimori’s tasks only',
    ],
  },
});
