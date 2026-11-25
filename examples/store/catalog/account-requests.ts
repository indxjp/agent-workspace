import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'account-requests',
  area: 'it',
  status: 'live',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/account-requests',
  name: {
    ja: 'アカウント申請',
    en: 'Access requests',
  },
  summary: {
    ja: '権限の申請を規程と役割に照らして案にし、承認のあとに一件ずつ登録する。',
    en: 'Checks access requests against the policy and role, and records each change once approved.',
  },
  demo: {
    agent: 'account-requests',
    prompts: [
      {
        ja: '営業部の楪 奏多さんに顧客管理システムの書き込み権限を付けて',
        en: 'Give Kanata Yuzuriha in Sales write access to the CRM',
      },
      {
        ja: '経理部の箙 陽菜さんに経費精算システムの書き込み権限を付けて',
        en: 'Give Hina Ebira in Accounting write access to the expense system',
      },
    ],
    moment: {
      ja: '権限の申請を伝えると、規程と役割を確かめて変更を案にし、一件ずつ承認を待って登録する。',
      en: 'Ask for access; it checks the policy and the role, proposes the change and records each one only after a person approves it.',
    },
    data: {
      ja: '架空の権限付与規程、人事データ、現在の権限の一覧',
      en: 'A fictional access policy, HR records and a list of current access',
    },
    seed: [{ collection: 'account-requests', from: 'data' }],
    check: { tools: ['search_files'], approval: 'change_access' },
  },
  safety: ['approval', 'structured', 'files'],
});
