import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'project-status',
  area: 'collab',
  status: 'live',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/project-status',
  name: {
    ja: 'プロジェクト週報',
    en: 'Project status',
  },
  summary: {
    ja: 'タスク・マイルストーン・リスクから、赤・黄・緑の週報を作る。',
    en: 'Writes the weekly red, amber or green status from tasks, milestones and risks.',
  },
  demo: {
    agent: 'project-status',
    prompts: [
      {
        ja: '2026-11-27 のプロジェクト週報を作成して',
        en: 'Write the project status report for 2026-11-27',
      },
      {
        ja: 'データ移行の作業の流れに絞って、2026-11-27 のプロジェクト週報を作成して',
        en: 'Write the project status report for 2026-11-27 for the data migration workstream only',
      },
    ],
    moment: {
      ja: '作業の流れごとの赤・黄・緑が根拠つきで並び、保存は承認を待つ。',
      en: 'Each workstream is rated red, amber or green with its evidence; the save waits for approval.',
    },
    data: {
      ja: '架空のプロジェクトのタスク・マイルストーン・リスク',
      en: 'a fictional project’s tasks, milestones and risks',
    },
    seed: [{ collection: 'project-status', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'Write' },
  },
  safety: ['approval', 'trigger', 'structured', 'files'],
});
