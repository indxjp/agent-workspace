import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'case-file',
  area: 'legal',
  status: 'soon',
  wave: 3,
  name: {
    ja: '紛争資料の整理',
    en: 'Case file organizer',
  },
  summary: {
    ja: 'メールと文書を時系列に並べ、論点ごとに整理する。',
    en: 'Orders emails and documents in time and groups them by issue.',
  },
});
