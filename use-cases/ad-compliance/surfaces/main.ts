import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'ad-compliance',
  title: '広告表現チェック / Ad compliance',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '広告や商品ページの原稿を添付するか、ad-compliance/inbox のファイルを指定してください。自社の広告表示基準と、表現ごとに照らします。 / Attach the ad or product-page copy, or name a file in ad-compliance/inbox, and I will check each claim against your advertising standard.',
    suggestedPrompts: [
      'ad-compliance/inbox/LP原稿_加湿空気清浄機KAZE-9.md をチェックして',
      'Check ad-compliance/inbox/LP原稿_加湿空気清浄機KAZE-9.md',
      'AD-03 の通常価格の基準を説明して',
    ],
    disclaimer:
      '判定は社内基準にもとづく判断材料で、法的助言ではありません。掲載するかどうかは担当者が決めます。 / The verdicts follow your in-house standard and are not legal advice. A person decides whether to publish.',
    toolTrace: 'collapsed',
    history: true,
  },
});
