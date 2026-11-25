import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'handover',
  area: 'collab',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/handover',
  name: {
    ja: '引き継ぎ資料',
    en: 'Handover pack',
  },
  summary: {
    ja: '担当者の文書とやり取りから引き継ぎ資料を作る。',
    en: "Builds a handover pack from someone's documents and threads.",
  },
  demo: {
    agent: 'handover',
    prompts: [
      {
        ja: '購買担当の引き継ぎの依頼メモに沿って、引き継ぎ資料を作成して',
        en: 'Draft the handover pack for the purchasing role as the request asks',
      },
      {
        ja: '購買担当の引き継ぎ資料の構成だけを示して',
        en: 'Show only the outline of the handover pack for the purchasing role',
      },
    ],
    moment: {
      ja: 'タスク一覧とやり取りから、進行中の案件・定例業務・窓口・確認事項が出典つきで並び、引き継ぎ資料の Word の書き出しが承認待ちになる。人の評価は出さない。',
      en: 'From the task list and threads, the cases in progress, routine work, contacts and open points are listed with their sources, with no assessment of anyone, and the Word handover pack waits for approval.',
    },
    data: {
      ja: '架空の購買担当のタスク一覧・取引先とのやり取り・手順書・連絡先一覧',
      en: "a fictional buyer's task list, supplier threads, procedure and contact list",
    },
    seed: [{ collection: 'handover', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['person', 'approval', 'files', 'structured'],
});
