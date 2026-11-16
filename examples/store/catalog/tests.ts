import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'tests',
  area: 'it',
  status: 'soon',
  wave: 3,
  name: {
    ja: 'テスト作成',
    en: 'Test writer',
  },
  summary: {
    ja: '仕様書からテストケースとテストコードの下書きを作る。',
    en: 'Drafts test cases and test code from a spec.',
  },
});
