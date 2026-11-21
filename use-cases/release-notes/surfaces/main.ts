import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'release-notes',
  title: 'リリースノート作成 / Release notes',
  layout: 'page',
  parts: {
    greeting:
      'マージ済みの PR 一覧から、利用者向けのリリースノートを種類ごとにまとめて Word で作ります。書き出す前に承認をお願いします。 / From the export of merged pull requests, I draft user-facing release notes grouped by type as a Word document, and ask for your approval before writing it.',
    suggestedPrompts: [
      'v3.8.0 のマージ済み PR 一覧からリリースノートを作成して',
      'Draft the release notes for v3.8.0 from the merged PR export',
      'v3.8.0 のリリースノートの構成だけを示して',
    ],
    disclaimer:
      '下書きです。担当者が確認してから公開します。 / A draft: a person checks it before it is published.',
    toolTrace: 'collapsed',
    history: true,
  },
});
