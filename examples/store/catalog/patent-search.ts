import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'patent-search',
  area: 'legal',
  status: 'soon',
  wave: 3,
  name: {
    ja: '特許調査',
    en: 'Patent search',
  },
  summary: {
    ja: '技術メモから先行特許を探し、近いものを比較表にする。',
    en: 'Finds prior patents for a technical note and compares the closest ones.',
  },
});
