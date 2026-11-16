import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'manual-search',
  area: 'knowledge',
  status: 'live',
  wave: 1,
  kind: 'agent',
  source: 'tests/gallery/manual-search',
  name: {
    ja: 'マニュアル検索',
    en: 'Manual search agent',
  },
  summary: {
    ja: '社内マニュアルや手順書を横断して探し、該当ページを引用して答える。',
    en: 'Searches manuals and procedures and answers with the page it came from.',
  },
  demo: {
    agent: 'manual-search',
    prompts: [
      {
        ja: '油圧ユニットの定期点検の周期は？',
        en: "How often is the hydraulic unit's periodic inspection due?",
      },
      {
        ja: '作動油はいつ交換すればいいですか',
        en: 'When should the hydraulic oil be replaced?',
      },
    ],
    moment: {
      ja: '答えに必ず「どのマニュアルの何ページか」が付き、クリックで原文が開く。',
      en: 'Every answer names the manual and page, and opens the original on click.',
    },
    data: {
      ja: '設備・安全のマニュアル2冊（PDFと本文テキスト）',
      en: '2 manuals (equipment, safety) as PDF and text',
    },
    seed: [{ collection: 'manuals', from: 'data/manuals' }],
    check: { tools: ['search_files'], approval: null },
  },
  safety: ['person', 'files'],
});
