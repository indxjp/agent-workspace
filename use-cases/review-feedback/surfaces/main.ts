import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'review-feedback',
  title: '評価コメント支援 / Review feedback',
  layout: 'page',
  parts: {
    greeting:
      '目標シートと実績のメモから、社内の書き方に沿って、目標ごとの評価コメントの下書きを Word で作ります。評語や順位はつけません。書き出す前に承認をお願いします。 / From the goal sheet and the achievement notes, I draft review comments goal by goal as a Word document, following your guide. I never give a rating or a rank, and I ask for your approval before writing it.',
    suggestedPrompts: [
      '鴎谷菜摘さんの目標シートと実績メモから、上期の評価コメント案を作成して',
      "Draft Natsumi Kamomeya's first-half review comments from the goal sheet and notes",
      '鴎谷菜摘さんの評価コメント案の構成だけを示して',
      "Show only the outline of Natsumi Kamomeya's review comments",
    ],
    disclaimer:
      '下書きです。評語は評価者が評価会議で決め、コメントを仕上げます。 / A draft: the reviewer decides the rating at the review meeting and finishes the comments.',
    toolTrace: 'collapsed',
    history: true,
  },
});
