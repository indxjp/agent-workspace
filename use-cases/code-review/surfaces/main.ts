import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'code-review',
  title: 'コードレビュー / Code reviewer',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      'パッチ（差分）のファイルを添付するか、code-review/inbox のファイルを指定してください。チームのコーディング規約のルールごとに、行と修正案を添えて判定します。 / Attach a patch or name a file in code-review/inbox, and I will review it rule by rule against your coding standard, with the line and a fix.',
    suggestedPrompts: [
      'code-review/inbox/0001-member-search.patch をコーディング規約でレビューして',
      'Review code-review/inbox/0001-member-search.patch against the coding standard',
      'CS-03 のSQLのルールを説明して',
    ],
    disclaimer:
      '差分を読んで判定します。コードは実行しません。マージするかどうかはレビュー担当者が決めます。 / It reads the diff and never runs the code. A person decides whether to merge.',
    toolTrace: 'collapsed',
    history: true,
  },
});
