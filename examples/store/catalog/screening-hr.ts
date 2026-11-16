import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'screening-hr',
  area: 'hr',
  status: 'soon',
  wave: 2,
  name: {
    ja: '書類選考サポート',
    en: 'Screening assistant',
  },
  summary: {
    ja: '募集要項に照らして応募書類の要点を整理する（合否は人が判断）。',
    en: 'Summarizes applications against the job description (a person decides).',
  },
});
