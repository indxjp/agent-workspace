import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'kpi',
  area: 'analytics',
  status: 'soon',
  wave: 2,
  name: {
    ja: 'KPIレポート',
    en: 'KPI report',
  },
  summary: {
    ja: '毎週の数字を集め、大きく動いた指標を解説付きで報告する。',
    en: 'Collects weekly numbers and explains the metrics that moved.',
  },
});
