import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'kyt',
  area: 'mfg',
  status: 'soon',
  wave: 3,
  name: {
    ja: '危険予知（KY）支援',
    en: 'Hazard prediction',
  },
  summary: {
    ja: '作業内容から想定される危険と対策のKYシートを作る。',
    en: 'Builds a hazard-prediction sheet with risks and countermeasures for a task.',
  },
});
