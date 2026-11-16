import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'daily-report',
  area: 'mfg',
  status: 'soon',
  wave: 3,
  name: {
    ja: '生産日報まとめ',
    en: 'Production daily',
  },
  summary: {
    ja: '各ラインの日報から稼働率と課題をまとめる。',
    en: 'Rolls up line reports into utilization and issues.',
  },
});
