import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'nda',
  area: 'legal',
  status: 'soon',
  wave: 2,
  name: {
    ja: 'NDAチェック',
    en: 'NDA checker',
  },
  summary: {
    ja: '受け取ったNDAを自社のひな形と比べ、違いを報告する。',
    en: 'Compares an incoming NDA with your template and reports the differences.',
  },
});
