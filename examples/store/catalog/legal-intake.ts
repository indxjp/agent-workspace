import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'legal-intake',
  area: 'legal',
  status: 'soon',
  wave: 3,
  name: {
    ja: '法務相談受付',
    en: 'Legal intake',
  },
  summary: {
    ja: '社内からの相談を分類し、必要な資料をそろえて法務に渡す。',
    en: 'Sorts internal legal requests and hands them over with the right documents.',
  },
});
