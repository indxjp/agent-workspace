import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'glossary',
  title: '用語チェック / Terminology check',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '確認する文書を添付するか、glossary/inbox のファイルを指定してください。社内用語集と照らして、用語ごとに推奨語を示します。 / Attach a document or name a file in glossary/inbox, and I will check each term against the company glossary and give the preferred term.',
    suggestedPrompts: [
      'glossary/inbox/シギノ・リンク_かんたん操作ガイド_草稿.md の用語をチェックして',
      'Check the terms in glossary/inbox/シギノ・リンク_かんたん操作ガイド_草稿.md',
      'TERM-05 のアラートの使い分けを説明して',
    ],
    disclaimer:
      '判定は判断材料です。どう直すかは担当者が決めます。 / The verdicts are input: the writer decides what to change.',
    toolTrace: 'collapsed',
    history: true,
  },
});
