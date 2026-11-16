import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'logs',
  area: 'it',
  status: 'soon',
  wave: 3,
  name: {
    ja: 'ログ分析',
    en: 'Log analyst',
  },
  summary: {
    ja: '大量のログから異常のパターンと発生時刻を特定する。',
    en: 'Finds anomaly patterns and timings in large logs.',
  },
});
