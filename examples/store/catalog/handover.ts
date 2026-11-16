import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'handover',
  area: 'collab',
  status: 'soon',
  wave: 3,
  name: {
    ja: '引き継ぎ資料',
    en: 'Handover pack',
  },
  summary: {
    ja: '担当者の文書とやり取りから引き継ぎ資料を作る。',
    en: "Builds a handover pack from someone's documents and threads.",
  },
});
