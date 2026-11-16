import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'scheduling',
  area: 'collab',
  status: 'soon',
  wave: 3,
  name: {
    ja: '日程調整',
    en: 'Scheduling assistant',
  },
  summary: {
    ja: '参加者の予定を見て候補日時を出し、招待を送る。',
    en: 'Finds slots across calendars and sends the invite.',
  },
});
