import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'slides',
  area: 'knowledge',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/slides',
  name: {
    ja: '資料ドラフト',
    en: 'Slide drafter',
  },
  summary: {
    ja: '要点メモから、社内のスライドの書き方に沿ってPowerPointの下書きを作る。数字と予定は資料から写す。',
    en: 'Drafts a PowerPoint deck from bullet notes, following your slide guide, with figures and dates copied from the sources.',
  },
  demo: {
    agent: 'slides',
    prompts: [
      {
        ja: 'ヘルプデスク刷新の要点メモから、部門長会議のスライドを作成して',
        en: "Draft the department heads' meeting deck from the help desk renewal notes",
      },
      {
        ja: 'ヘルプデスク刷新の中間報告のスライド構成だけを示して',
        en: 'Show only the slide outline of the help desk renewal interim report',
      },
    ],
    moment: {
      ja: '要点メモを渡すと、スライドごとのタイトルと箇条書きが出典付きで出て、PowerPoint の書き出しが承認待ちになる。資料にない数字は作らない。',
      en: "Hand over the bullet notes; out comes each slide's title and bullets with their sources, no figure the sources lack, and the PowerPoint deck waits for approval.",
    },
    data: {
      ja: '架空の要点メモ・問い合わせ件数の集計・プロジェクトの計画と進捗・社内のスライドの書き方',
      en: 'fictional bullet notes, request counts, a project plan with its progress and an internal slide guide',
    },
    seed: [{ collection: 'slides', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['approval', 'files', 'structured'],
});
