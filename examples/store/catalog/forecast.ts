import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'forecast',
  area: 'analytics',
  status: 'soon',
  wave: 2,
  name: {
    ja: '売上予測',
    en: 'Sales forecast',
  },
  summary: {
    ja: '過去の実績と商談の状況から今期の着地見込みを作る。',
    en: 'Forecasts the quarter from history and the pipeline.',
  },
});
