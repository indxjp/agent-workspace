import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'attendance',
  area: 'hr',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/attendance',
  name: {
    ja: '勤怠チェック',
    en: 'Attendance check',
  },
  summary: {
    ja: '打刻漏れと、残業の上限への接近を週ごとに見つけ、上長が読む報告を上長ごとにまとめて作る。人の評価はしない。',
    en: 'Finds missed clock-ins and overtime nearing the limit each week, and writes a report for managers to read, grouped by manager. It never rates anyone.',
  },
  demo: {
    agent: 'attendance',
    prompts: [
      {
        ja: '2026-11-16 から 2026-11-20 の週の勤怠チェックを作成して',
        en: 'Write the attendance check for the week of 2026-11-16',
      },
      {
        ja: '2026-11-16 の週で、残業が上限に近い人と超えた人を上長ごとに教えて',
        en: 'For the week of 2026-11-16, who is near or over the overtime limit, by manager?',
      },
    ],
    moment: {
      ja: '打刻漏れと残業の上限への接近が上長ごとに出典つきで並び、人の評価や休暇の理由は書かず、保存は承認を待つ。',
      en: 'Missed clock-ins and overtime nearing the limit appear for each manager with sources, nobody is rated, no reason for leave is written, and the save waits for approval.',
    },
    data: {
      ja: '架空の打刻データ・月次集計・勤怠チェックのルール',
      en: 'a fictional timeclock export, monthly summary and attendance rules',
    },
    seed: [{ collection: 'attendance', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'Write' },
  },
  safety: ['person', 'approval', 'trigger', 'structured', 'files'],
});
