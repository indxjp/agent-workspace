import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'attendance',
  title: '勤怠チェック / Attendance check',
  layout: 'side',
  parts: {
    greeting:
      '打刻データと月次集計から、打刻漏れと残業の上限への接近を上長ごとにまとめます。人の評価はしません。 / From the timeclock export and the monthly summary, I list missed clock-ins and overtime nearing the limit for each manager. I never rate anyone.',
    suggestedPrompts: [
      '2026-11-16 から 2026-11-20 の週の勤怠チェックを作成して',
      'Write the attendance check for the week of 2026-11-16',
      '2026-11-16 の週で、残業が上限に近い人と超えた人を上長ごとに教えて',
      'For the week of 2026-11-16, who is near or over the overtime limit, by manager?',
    ],
    disclaimer:
      '打刻の修正と業務量の調整のための確認です。人の評価や処分には使いません。 / For correcting punches and adjusting workloads, never for rating or discipline.',
  },
});
