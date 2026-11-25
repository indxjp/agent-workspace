import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'announce',
  title: '社内告知文 / Announcement writer',
  layout: 'page',
  parts: {
    greeting:
      '決定メモから、日本語版と英語版の社内告知を一つの Word 文書で作ります。書き出す前に承認をお願いします。 / From a decision memo, I draft an internal announcement in Japanese and English as one Word document, and ask for your approval before writing it.',
    suggestedPrompts: [
      '決定メモ DM-2026-014 から社内告知を作成して',
      'Draft the internal announcement from decision memo DM-2026-014',
      'DM-2026-014 の社内告知の構成だけを示して',
    ],
    disclaimer:
      '下書きです。担当者が確認してから送ります。 / A draft: a person checks it before it is sent.',
    toolTrace: 'collapsed',
    history: true,
  },
});
