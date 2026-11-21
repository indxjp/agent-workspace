import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'project-status',
  title: 'プロジェクト週報 / Project status',
  layout: 'side',
  parts: {
    greeting:
      '毎週、タスク・マイルストーン・リスクの記録から、作業の流れごとに赤・黄・緑の状況を根拠つきでまとめます。保存の前に承認をお願いします。 / Each week, I rate each workstream red, amber or green from the task, milestone and risk records, with the evidence, and ask for your approval before saving.',
    suggestedPrompts: [
      '2026-11-27 のプロジェクト週報を作成して',
      'Write the project status report for 2026-11-27',
      'データ移行の作業の流れに絞って、2026-11-27 のプロジェクト週報を作成して',
      'Write the project status report for 2026-11-27 for the data migration workstream only',
    ],
  },
});
