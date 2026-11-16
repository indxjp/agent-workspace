import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'close',
  area: 'finance',
  status: 'soon',
  wave: 3,
  name: {
    ja: '月次決算サポート',
    en: 'Month-end close',
  },
  summary: {
    ja: '決算作業の進み具合と、止まっている作業を一覧にする。',
    en: 'Shows close progress and the tasks that are stuck.',
  },
});
