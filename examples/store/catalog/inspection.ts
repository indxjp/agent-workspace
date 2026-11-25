import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'inspection',
  area: 'mfg',
  status: 'live',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/inspection',
  name: {
    ja: '検査成績書チェック',
    en: 'Inspection report checker',
  },
  summary: {
    ja: '検査データの規格外れや記入漏れを見つける。',
    en: 'Finds out-of-spec values and missing entries in inspection data.',
  },
  demo: {
    agent: 'inspection',
    prompts: [
      {
        ja: 'inspection/inbox/検査記録_BK-210_ロット2611-07.csv をチェックして',
        en: 'Check inspection/inbox/検査記録_BK-210_ロット2611-07.csv',
      },
      {
        ja: 'INS-04 の硬さの規格を教えて',
        en: 'What is the INS-04 hardness specification?',
      },
    ],
    moment: {
      ja: '検査記録を指定すると、項目ごとに規格外れと記入漏れが「OK・要注意・NG」で並び、保存は承認を待つ。',
      en: 'Name an inspection record; each item is marked OK, caution or NG for out-of-spec values and blanks, and saving waits for approval.',
    },
    data: {
      ja: '架空の部品の検査記録CSV・検査基準書',
      en: 'fictional inspection record CSVs, an inspection standard',
    },
    seed: [{ collection: 'inspection', from: 'data/ja' }],
    check: { tools: ['Read'], approval: 'Write' },
  },
  safety: ['approval', 'files', 'structured'],
});
