import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'translator',
  area: 'knowledge',
  status: 'soon',
  wave: 2,
  name: {
    ja: '文書翻訳',
    en: 'Document translator',
  },
  summary: {
    ja: '用語集に沿って社内文書を翻訳し、レイアウトを保ったまま返す。',
    en: 'Translates documents with your glossary and keeps the layout.',
  },
});
