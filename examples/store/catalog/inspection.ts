import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'inspection',
  area: 'mfg',
  status: 'soon',
  wave: 2,
  name: {
    ja: '検査成績書チェック',
    en: 'Inspection report checker',
  },
  summary: {
    ja: '検査データの規格外れや記入漏れを見つける。',
    en: 'Finds out-of-spec values and missing entries in inspection data.',
  },
});
