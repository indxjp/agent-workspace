import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'review-feedback',
  area: 'hr',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/review-feedback',
  name: {
    ja: '評価コメント支援',
    en: 'Review feedback',
  },
  summary: {
    ja: '目標シートと実績のメモから、社内の書き方に沿って、目標ごとの評価コメントの下書きを作る。評語や順位はつけない。',
    en: 'Drafts review comments goal by goal from the goal sheet and the achievement notes, following your guide. It never gives a rating or a rank.',
  },
  demo: {
    agent: 'review-feedback',
    prompts: [
      {
        ja: '鴎谷菜摘さんの目標シートと実績メモから、上期の評価コメント案を作成して',
        en: "Draft Natsumi Kamomeya's first-half review comments from the goal sheet and notes",
      },
      {
        ja: '鴎谷菜摘さんの評価コメント案の構成だけを示して',
        en: "Show only the outline of Natsumi Kamomeya's review comments",
      },
    ],
    moment: {
      ja: '目標シートと実績メモを渡すと、目標ごとの事実・よかった行動・次の期への期待の構成が出典付きで出て、Word の書き出しが承認待ちになる。評語や順位は出さない。',
      en: 'Hand over the goal sheet and notes; out comes an outline of facts, behaviour that went well and next steps for each goal, each with its source, with no rating or rank, and the Word document waits for approval.',
    },
    data: {
      ja: '架空の目標シート・上長の実績メモと本人の自己申告・評価コメントの書き方',
      en: "a fictional goal sheet, a manager's notes with a self-assessment, and a guide for review comments",
    },
    seed: [{ collection: 'review-feedback', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['person', 'approval', 'files', 'structured'],
});
