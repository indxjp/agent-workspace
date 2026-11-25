import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: '__slug__',
  title: 'レビュー / Review',
  layout: 'page',
  parts: {
    attachments: true,
    greeting: '確認する文書を指定してください。 / Name the document to review.',
    suggestedPrompts: [
      '__slug__/inbox の文書をレビューして',
      'Review the document in __slug__/inbox',
    ],
    disclaimer: '判定は判断材料です。決めるのは担当者です。 / A person makes the decision.',
    toolTrace: 'collapsed',
    history: true,
  },
});
