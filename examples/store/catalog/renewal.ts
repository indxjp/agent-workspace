import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'renewal',
  area: 'sales',
  status: 'soon',
  wave: 3,
  name: {
    ja: '契約更新リマインド',
    en: 'Renewal reminder',
  },
  summary: {
    ja: '更新期限の近い契約を拾い、更新案内メールの下書きを用意する。',
    en: 'Finds contracts nearing renewal and drafts the renewal email.',
  },
});
