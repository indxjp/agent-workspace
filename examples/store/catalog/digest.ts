import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'digest',
  area: 'knowledge',
  status: 'soon',
  wave: 3,
  name: {
    ja: '調査ダイジェスト',
    en: 'Research digest',
  },
  summary: {
    ja: '指定テーマの社内外の資料を週に1度まとめて届ける。',
    en: 'Sends a weekly digest of internal and external material on a topic.',
  },
});
