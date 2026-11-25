import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'refund',
  title: '返金審査 / Refund review',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '返金の申請を添付するか、refund/inbox のファイルを指定してください。返金規程と請求データに照らして、承認者に渡す判断材料をまとめます。 / Attach a refund request or name a file in refund/inbox, and I will check it against the refund policy and the billing record and put the facts together for the approver.',
    suggestedPrompts: [
      'refund/inbox/RQ-2611-018_返金申請.md を返金規程に照らして確認して',
      'Check refund/inbox/RQ-2611-018_返金申請.md against the refund policy',
      'refund/inbox/RQ-2611-018_返金申請.md の申請金額が請求データと合っているか、RF-04 だけ確かめて',
      'Check only RF-04: does the amount in refund/inbox/RQ-2611-018_返金申請.md match the billing record?',
    ],
    disclaimer:
      '判定は返金規程にもとづく判断材料です。返金の実行や約束はしません。返金するかどうかは承認者が決めます。 / The verdicts follow your refund policy. It never carries out or promises a refund; the approver decides.',
    toolTrace: 'collapsed',
    history: true,
  },
});
