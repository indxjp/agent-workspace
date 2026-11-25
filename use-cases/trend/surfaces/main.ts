import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'trend',
  title: 'トレンドウォッチ / Trend watch',
  layout: 'side',
  parts: {
    greeting:
      '毎朝、追いかけているトピックに関係するニュースと公開投稿を、出典と公開情報の時点つきでまとめます。保存の前に承認をお願いします。 / Every morning, I gather the news and public posts on the topics you follow, with the source and the date of the public sources, and ask for your approval before saving.',
    suggestedPrompts: [
      '2026-11-21 のトレンドダイジェストを作成して',
      'Write the trend digest for 2026-11-21',
      '2026-11-19 のトレンドダイジェストを作成して',
      'Write the trend digest for 2026-11-19',
    ],
  },
});
