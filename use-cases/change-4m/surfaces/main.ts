import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'change-4m',
  title: '4M変更管理 / 4M change tracker',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '4M変更申請を添付するか、change-4m/inbox のファイルを指定してください。変更管理規程に照らし、部品使用先一覧から影響する品番と顧客への届け出の要否を洗い出します。 / Attach a 4M change request or name a file in change-4m/inbox, and I will check it against your change control rules and map the affected products and customer notices from the parts usage list.',
    suggestedPrompts: [
      'change-4m/inbox/変更申請_CR-2611-05_材料変更.md を4M変更管理規程に照らしてチェックして',
      'Check change-4m/inbox/変更申請_CR-2611-05_材料変更.md against the 4M change rules',
      'change-4m/inbox/変更申請_CR-2611-05_材料変更.md の影響範囲を部品使用先一覧と照らして、CHG-02 だけ確かめて',
      'Check only CHG-02 for change-4m/inbox/変更申請_CR-2611-05_材料変更.md against the parts usage list',
    ],
    disclaimer:
      '判定は変更管理規程と部品使用先一覧にもとづく判断材料です。変更の承認や顧客への連絡はしません。承認するかどうかは品質保証課が決めます。 / The verdicts follow your change control rules and parts usage list. It never approves a change or contacts a customer; quality assurance decides.',
    toolTrace: 'collapsed',
    history: true,
  },
});
