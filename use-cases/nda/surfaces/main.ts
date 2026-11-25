import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'nda',
  title: 'NDAチェック / NDA checker',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '受け取ったNDAを添付するか、nda/inbox のファイルを指定してください。自社のひな形と条項ごとに比べます。 / Attach the NDA you received or name a file in nda/inbox, and I will compare it with your template clause by clause.',
    suggestedPrompts: [
      'nda/inbox/秘密保持契約書_株式会社ツバメ技研案.md をレビューして',
      'Review nda/inbox/秘密保持契約書_株式会社ツバメ技研案.md',
      'NDA-05 の有効期間の基準を説明して',
    ],
    disclaimer:
      '判定は判断材料で、法的助言ではありません。署名するかどうかは担当者が決めます。 / The verdicts are not legal advice. A person decides whether to sign.',
    toolTrace: 'collapsed',
    history: true,
  },
});
