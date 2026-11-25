import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'close',
  area: 'finance',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/close',
  name: {
    ja: '月次決算サポート',
    en: 'Month-end close',
  },
  summary: {
    ja: '決算作業の進み具合と、止まっている作業を一覧にする。',
    en: 'Shows close progress and the tasks that are stuck.',
  },
  demo: {
    agent: 'close',
    prompts: [
      {
        ja: '2026-12-03 時点の11月度の月次決算の進捗レポートを作成して',
        en: 'Write the November close progress report as of 2026-12-03',
      },
      {
        ja: '杉森さんの担当作業に絞って、2026-12-03 時点の11月度の月次決算の進捗レポートを作成して',
        en: 'Write the November close progress report as of 2026-12-03 for Ren Sugimori’s tasks only',
      },
    ],
    moment: {
      ja: '決算作業の進み具合と、止まっている作業が担当者と止まっている理由つきで並び、保存は承認を待つ。仕訳は計上しない。',
      en: 'The close’s progress and its stuck tasks are listed with the owner and what blocks them; the save waits for approval, and no entry is posted.',
    },
    data: {
      ja: '架空の決算管理ツールの作業一覧と進捗集計',
      en: 'a fictional close checklist and progress summary',
    },
    seed: [{ collection: 'close', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'Write' },
  },
  safety: ['approval', 'trigger', 'structured', 'files'],
});
