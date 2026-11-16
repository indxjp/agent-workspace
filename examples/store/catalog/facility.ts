import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'facility',
  area: 'hr',
  status: 'soon',
  wave: 3,
  name: {
    ja: '設備予約',
    en: 'Facility booking',
  },
  summary: {
    ja: '会議室や社用車の予約・変更を会話で受け付ける。',
    en: 'Books and changes rooms and pool cars in chat.',
  },
});
