import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'patent-search',
  area: 'legal',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/patent-search',
  name: {
    ja: '特許調査',
    en: 'Patent search',
  },
  summary: {
    ja: '技術メモから先行特許を探し、近いものを比較表にする。',
    en: 'Finds prior patents for a technical note and compares the closest ones.',
  },
  demo: {
    agent: 'patent-search',
    prompts: [
      {
        ja: '技術メモ_部品反転装置に近い先行特許を探して、比較表にして',
        en: 'Find prior patents close to the part-flipper technical memo and compare them in a table',
      },
      {
        ja: 'ハクセキ工業が出願した特許を一覧にして',
        en: 'List the patents filed by Hakuseki Kogyo',
      },
    ],
    moment: {
      ja: '技術メモを渡すと、近い特許公報が構成要素ごとの比較表で並び、公報番号と公開日の出典と、どの時点の公報かが示される。',
      en: 'Hand over a technical memo; the closest publications come back in a table by element, each cited by number and date, with the date the publications stand as of.',
    },
    data: {
      ja: '架空の特許公報の日付つきスナップショットと、社内の技術メモ',
      en: 'a dated snapshot of fictional patent publications, and an internal technical memo',
    },
    seed: [{ collection: 'patent-search', from: 'data/files' }],
    check: { tools: ['search_patents'], approval: null },
  },
  safety: ['structured', 'files'],
});
