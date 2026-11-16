import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'code-review',
  area: 'it',
  status: 'soon',
  wave: 2,
  name: {
    ja: 'コードレビュー',
    en: 'Code reviewer',
  },
  summary: {
    ja: 'プルリクエストを読み、バグの可能性と修正案をコメントする。',
    en: 'Reads pull requests and comments on likely bugs with fixes.',
  },
});
