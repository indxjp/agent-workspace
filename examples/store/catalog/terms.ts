import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'terms',
  area: 'legal',
  status: 'soon',
  wave: 3,
  name: {
    ja: '利用規約の改定',
    en: 'Terms updater',
  },
  summary: {
    ja: '規約の改定案について、新旧対照表とお知らせ文を作る。',
    en: 'Builds the before-and-after table and notice for a terms update.',
  },
});
