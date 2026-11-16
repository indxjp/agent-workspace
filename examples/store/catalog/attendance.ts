import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'attendance',
  area: 'hr',
  status: 'soon',
  wave: 2,
  name: {
    ja: '勤怠チェック',
    en: 'Attendance check',
  },
  summary: {
    ja: '残業の偏りや打刻漏れを見つけて上長に知らせる。',
    en: 'Spots overtime spikes and missed clock-ins and tells the manager.',
  },
});
