import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'expense',
  title: '経費精算チェック / Expense audit',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '経費精算の申請を添付するか、expense/inbox のファイルを指定してください。旅費・経費規程と、明細ごとに照らします。 / Attach an expense claim or name a file in expense/inbox, and I will check each line against the travel and expense policy.',
    suggestedPrompts: [
      'expense/inbox/経費精算_EX-2611-0042_渡瀬ハルキ.csv をチェックして',
      'Check expense/inbox/経費精算_EX-2611-0042_渡瀬ハルキ.csv',
      'EXP-03 のタクシーの規程を説明して',
    ],
    disclaimer:
      '判定は社内規程にもとづく判断材料で、税務上の助言ではありません。精算するかどうかは承認者が決めます。 / The verdicts follow your policy and are not tax advice. The approver decides what is paid.',
    toolTrace: 'collapsed',
    history: true,
  },
});
