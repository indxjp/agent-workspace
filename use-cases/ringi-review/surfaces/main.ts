import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'ringi-review',
  title: '稟議レビュー / Ringi review',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '回す前の稟議を添付するか、ringi-review/inbox のファイルを指定してください。規程と決裁権限の別表に照らして点検します。 / Attach a ringi or name a file in ringi-review/inbox, and I will check it against the rules and the authority schedule before it is circulated.',
    suggestedPrompts: [
      'ringi-review/inbox/R-2026-0101.md を回す前に点検して',
      'Check ringi-review/inbox/R-2026-0101.md before it is circulated',
      'ringi-review/inbox/R-2026-0115.md を点検して',
      'Check ringi-review/inbox/R-2026-0115.md',
    ],
    disclaimer:
      '点検は判断材料です。決裁するかどうかは決裁者が決めます。 / The check is input; the approver decides.',
    toolTrace: 'collapsed',
    history: true,
  },
});
