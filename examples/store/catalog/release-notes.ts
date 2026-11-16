import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'release-notes',
  area: 'it',
  status: 'soon',
  wave: 2,
  name: {
    ja: 'リリースノート作成',
    en: 'Release notes',
  },
  summary: {
    ja: '変更履歴から利用者向けのお知らせ文を作る。',
    en: 'Turns the change history into user-facing release notes.',
  },
});
