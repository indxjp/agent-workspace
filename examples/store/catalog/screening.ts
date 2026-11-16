import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'screening',
  area: 'legal',
  status: 'soon',
  wave: 2,
  name: {
    ja: '取引先チェック',
    en: 'Counterparty screening',
  },
  summary: {
    ja: '新規取引先を公開リストと照合し、確認結果を記録する。',
    en: 'Screens new counterparties against public lists and records the result.',
  },
});
