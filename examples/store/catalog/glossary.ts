import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'glossary',
  area: 'knowledge',
  status: 'soon',
  wave: 2,
  name: {
    ja: '用語集メンテナンス',
    en: 'Glossary keeper',
  },
  summary: {
    ja: '文書から社内用語を拾い、定義の揺れを指摘する。',
    en: 'Collects company terms and flags inconsistent definitions.',
  },
});
