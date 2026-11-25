import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'case-file',
  area: 'legal',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/case-file',
  name: {
    ja: '紛争資料の整理',
    en: 'Case file organizer',
  },
  summary: {
    ja: '案件のメールと契約・記録を時系列に並べ、論点ごとに整理した資料を出典付きで作る。どちらが正しいかや人の評価はしない。',
    en: "Orders a matter's emails, contract and records by date and groups them by issue, each with its source. It never says who is right or judges anyone.",
  },
  demo: {
    agent: 'case-file',
    prompts: [
      {
        ja: 'M-2026-08 の依頼メモに沿って、メールと文書を整理して',
        en: 'Organize the emails and documents of matter M-2026-08 as the request asks',
      },
      {
        ja: 'M-2026-08 の資料整理の構成だけを示して',
        en: 'Show only the outline of the case file for M-2026-08',
      },
    ],
    moment: {
      ja: '依頼メモを渡すと、時系列と論点ごとの資料の構成が出典付きで出て、Word の書き出しが承認待ちになる。どちらが正しいかや人の評価は出さない。',
      en: 'Hand over the request; out comes a chronology and the documents by issue, each with its source, with no view on who is right and no judgment of anyone, and the Word document waits for approval.',
    },
    data: {
      ja: '架空の取引先とのメールの書き出し・取引基本契約の抜粋・受入検査の記録',
      en: 'a fictional mail export with a supplier, a basic agreement excerpt and receiving inspection records',
    },
    seed: [{ collection: 'case-file', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['person', 'approval', 'files', 'structured'],
});
