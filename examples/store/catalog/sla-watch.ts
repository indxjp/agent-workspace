import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'sla-watch',
  area: 'support',
  status: 'soon',
  wave: 2,
  name: {
    ja: 'SLA監視',
    en: 'SLA watcher',
  },
  summary: {
    ja: '期限が迫るチケットを見つけ、担当とリーダーに知らせる。',
    en: 'Spots tickets close to their deadline and tells the owner and lead.',
  },
});
