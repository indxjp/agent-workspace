import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'contract-review',
  title: '契約書レビュー / Contract review',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '相手方の契約書ドラフトを添付するか、contract-review/inbox のファイルを指定してください。自社の審査基準と条項ごとに照らします。 / Attach the draft you received or name a file in contract-review/inbox, and I will check it clause by clause against your review standards.',
    suggestedPrompts: [
      'contract-review/inbox/業務委託契約書_株式会社ミサゴシステムズ案.md をレビューして',
      'Review contract-review/inbox/業務委託契約書_株式会社ミサゴシステムズ案.md',
      'PB-04 の審査基準を説明して',
      'Explain the PB-04 review standard.',
    ],
    disclaimer:
      '判定は判断材料で、法的助言ではありません。締結の可否は法務担当者が決めます。 / The verdicts are not legal advice. Legal decides whether to sign.',
    toolTrace: 'collapsed',
    history: true,
  },
});
