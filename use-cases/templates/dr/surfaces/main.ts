import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: '__slug__',
  title: '文書作成 / Drafting',
  layout: 'page',
  parts: {
    greeting:
      'メモと資料から文書の下書きを作ります。保存の前に承認をお願いします。 / I draft a document from your notes and sources, and ask for your approval before saving it.',
    suggestedPrompts: [
      'メモと資料から文書を作成して',
      'Draft the document from the notes and sources',
      'メモの要点だけで短い版の文書を作成して',
      'Draft a short version from the key points of the notes',
    ],
    disclaimer: '下書きです。内容は担当者が確認します。 / A draft: a person checks it.',
    toolTrace: 'collapsed',
    history: true,
  },
});
