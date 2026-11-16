import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'training',
  area: 'hr',
  status: 'soon',
  wave: 3,
  name: {
    ja: '研修計画',
    en: 'Training planner',
  },
  summary: {
    ja: 'スキル表から一人ひとりの研修計画案を作る。',
    en: 'Drafts a training plan per person from the skills matrix.',
  },
});
