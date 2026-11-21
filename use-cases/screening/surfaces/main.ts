import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'screening',
  title: '取引先チェック / Counterparty screening',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '取引先の登録申請書を添付するか、screening/inbox のファイルを指定してください。会社・役員・株主・最終需要者の名前を公開リストと照合し、一致の候補を示します。 / Attach a registration request or name a file in screening/inbox. I check the company, officers, shareholders and end user against the public lists and flag possible matches.',
    suggestedPrompts: [
      'screening/inbox/取引先登録申請_株式会社ミナセ精工.md を照合して',
      'Screen screening/inbox/取引先登録申請_株式会社ミナセ精工.md',
      'Teodor Vashkin という名前は公開リストにありますか？',
    ],
    disclaimer:
      '照合は表示された日付のリストに対する結果で、法的助言ではありません。取引するかどうかは担当者が決めます。 / Results cover the lists as of the date shown and are not legal advice. A person decides whether to do business.',
    toolTrace: 'collapsed',
    history: true,
  },
});
