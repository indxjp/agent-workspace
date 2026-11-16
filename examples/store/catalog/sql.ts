import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'sql',
  area: 'it',
  status: 'soon',
  wave: 3,
  name: {
    ja: 'SQLアシスタント',
    en: 'SQL assistant',
  },
  summary: {
    ja: '日本語の質問をSQLにして、結果を表とグラフで返す。',
    en: 'Turns a question into SQL and returns a table and chart.',
  },
});
