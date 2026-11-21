import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'interview',
  area: 'hr',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/interview',
  name: {
    ja: '面接記録の下書き',
    en: 'Interview summary',
  },
  summary: {
    ja: '面接官のメモと求人票から、要件ごとに聞けたことをまとめた面接記録を作る。評価はしない。',
    en: "Drafts an interview summary from the interviewer's notes, requirement by requirement. It never rates anyone.",
  },
  demo: {
    agent: 'interview',
    prompts: [
      {
        ja: '鶫野ひかるさんの一次面接メモから面接記録を作成して',
        en: 'Draft the interview summary for Hikaru Tsugumino from the first interview notes',
      },
      {
        ja: '鶫野ひかるさんの面接記録の構成だけを示して',
        en: 'Show only the outline of the interview summary for Hikaru Tsugumino',
      },
    ],
    moment: {
      ja: '面接メモを渡すと、要件ごとの記録の構成が出て、Word の書き出しが承認待ちになる。評価や合否は出さない。',
      en: 'Hand over the interview notes; out comes an outline of the evidence for each requirement, with no rating or verdict, and the Word document waits for approval.',
    },
    data: {
      ja: '架空の求人票と面接メモ',
      en: 'a fictional job description and interview notes',
    },
    seed: [{ collection: 'interview', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['person', 'approval', 'files', 'structured'],
});
