import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'cash',
  area: 'finance',
  status: 'soon',
  wave: 2,
  name: {
    ja: '資金繰り予測',
    en: 'Cash forecast',
  },
  summary: {
    ja: '入出金の予定から13週間の資金繰り表を更新する。',
    en: 'Updates a 13-week cash forecast from scheduled flows.',
  },
});
