import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'newcomer',
  title: '新人ガイド / New-joiner guide',
  layout: 'page',
  parts: {
    greeting:
      '入社資料にもとづいて質問に答え、入社者情報から最初の1週間のガイドを Word で作ります。書き出す前に承認をお願いします。 / I answer questions from the onboarding documents and draft a first-week guide as a Word document from the joiner sheet, and ask for your approval before writing it.',
    suggestedPrompts: [
      '柚木原さつきさんの初週ガイドを作成して',
      "Draft Satsuki Yugihara's first-week guide",
      '初日に持っていくものは？',
      'When can I start working from home?',
    ],
    disclaimer:
      '下書きです。内容は人事総務部とメンターが確認します。 / A draft: HR and the mentor check it.',
    toolTrace: 'collapsed',
    history: true,
  },
});
