import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'screening-hr',
  title: '書類選考サポート / Screening assistant',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '応募書類を添付するか、screening-hr/inbox のファイルを指定してください。募集要項の要件ごとに、根拠の記述を添えて整理します。 / Attach an application or name a file in screening-hr/inbox, and I will summarise it against each posted requirement, with the evidence.',
    suggestedPrompts: [
      'screening-hr/inbox/A-0412_職務経歴書.md を募集要項の要件ごとに整理して',
      'Summarise screening-hr/inbox/A-0412_職務経歴書.md against the posted requirements',
      'REQ-03 の要件の判断の目安を説明して',
    ],
    disclaimer:
      '要件ごとの整理は判断材料です。順位や点数は付けず、選考の判断は担当者が行います。 / The summary is input only: it never ranks or scores anyone, and a person makes every hiring decision.',
    toolTrace: 'collapsed',
    history: true,
  },
});
