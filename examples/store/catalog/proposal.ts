import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'proposal',
  area: 'sales',
  status: 'live',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/proposal',
  name: {
    ja: '提案書ドラフト',
    en: 'Proposal drafter',
  },
  summary: {
    ja: 'ヒアリングメモから、課題・解決策・費用の骨子とスライド構成を作る。',
    en: 'Turns discovery notes into an outline: problem, solution, cost, and a slide plan.',
  },
  demo: {
    agent: 'proposal',
    prompts: [
      {
        ja: 'ヒバリノ精機の打ち合わせメモと要件一覧から提案書を作成して',
        en: 'Draft the proposal for Hibarino Seiki from the meeting notes and requirements',
      },
      {
        ja: 'ヒバリノ精機向けの提案書の構成だけを示して',
        en: 'Show only the outline of the proposal for Hibarino Seiki',
      },
    ],
    moment: {
      ja: 'メモと要件を渡すと、出典付きの提案書の構成が出て、PowerPoint の書き出しが承認待ちになる。',
      en: 'Hand over the notes and requirements; out comes a sourced proposal outline, and the PowerPoint deck waits for approval.',
    },
    data: {
      ja: '架空の打ち合わせメモ・要件一覧・製品資料・料金表・導入事例',
      en: 'fictional meeting notes, requirements, product sheets, price list and case studies',
    },
    seed: [{ collection: 'proposal', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['approval', 'files', 'structured'],
});
