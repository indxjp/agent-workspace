import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'offboarding',
  area: 'hr',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/offboarding',
  name: {
    ja: '退職手続き',
    en: 'Offboarding',
  },
  summary: {
    ja: '返却物と引き継ぎを一覧にし、権限の取り消しを一件ずつ承認のあとに登録する。',
    en: 'Lists returns and handover, and records each access removal once approved.',
  },
  demo: {
    agent: 'offboarding',
    prompts: [
      {
        ja: '12月11日に最終出社の汀 千尋さんの退職手続きを進めて',
        en: 'Start the offboarding for Chihiro Migiwa, whose last working day is December 11',
      },
      {
        ja: '生産管理部の樋渡 紗英さんの退職手続きを進めて',
        en: 'Start the offboarding for Sae Hiwatari in Production Control',
      },
    ],
    moment: {
      ja: '退職する人の名前を伝えると、返却物と引き継ぎを一覧にし、権限の取り消しを一件ずつ承認を待って登録する。',
      en: 'Name a leaver; it lists the returns and the handover, and records each access removal only after a person approves it.',
    },
    data: {
      ja: '架空の退職手続きのチェックリスト、人事データ、貸与品の台帳、現在の権限の一覧',
      en: 'A fictional offboarding checklist, HR records, a register of lent items and a list of current access',
    },
    seed: [{ collection: 'offboarding', from: 'data' }],
    check: { tools: ['search_files'], approval: 'change_access' },
  },
  safety: ['approval', 'person', 'structured', 'files'],
});
