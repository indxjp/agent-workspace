import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'inspection',
  title: '検査成績書チェック / Inspection report checker',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '検査記録を添付するか、inspection/inbox のファイルを指定してください。検査基準書と、項目ごとに照らします。 / Attach an inspection record or name a file in inspection/inbox, and I will check each item against the inspection standard.',
    suggestedPrompts: [
      'inspection/inbox/検査記録_BK-210_ロット2611-07.csv をチェックして',
      'Check inspection/inbox/検査記録_BK-210_ロット2611-07.csv',
      'INS-04 の硬さの規格を教えて',
    ],
    disclaimer:
      '判定は検査基準書にもとづく判断材料です。ロットの処置は品質保証の担当者が決めます。 / The verdicts follow the inspection standard. A person in quality assurance decides what happens to the lot.',
    toolTrace: 'collapsed',
    history: true,
  },
});
