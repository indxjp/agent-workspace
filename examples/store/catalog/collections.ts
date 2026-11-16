import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'collections',
  area: 'finance',
  status: 'soon',
  wave: 3,
  name: {
    ja: '売掛金回収',
    en: 'Collections assistant',
  },
  summary: {
    ja: '入金の遅れている取引先を拾い、督促メールの下書きを作る。',
    en: 'Finds late payers and drafts reminder emails.',
  },
});
