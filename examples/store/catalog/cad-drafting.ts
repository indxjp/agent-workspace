import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'cad-drafting',
  area: 'mfg',
  status: 'live',
  wave: 1,
  kind: 'agent',
  source: 'tests/gallery/cad-drafting',
  name: {
    ja: '図面作成支援',
    en: 'CAD drawing agent',
  },
  summary: {
    ja: '仕様と過去の図面から図面の下書きと部品表を作り、設計者のレビューに回す。',
    en: 'Drafts a drawing and parts list from the spec and past drawings, then sends it to a designer for review.',
  },
  demo: {
    agent: 'cad-drafting',
    prompts: [
      {
        ja: 'ブラケット 140×90、SUS304 t2.0、φ9 の取付穴4か所（左下から 15,15 / 125,15 / 15,75 / 125,75）、新図番 BRK-1101。似た過去図面を探して作図して。',
        en: 'Bracket 140×90, SUS304 t2.0, four φ9 mounting holes (from the lower left: 15,15 / 125,15 / 15,75 / 125,75), new drawing number BRK-1101. Find the closest past drawing and draft it.',
      },
      {
        ja: 'ブラケットを新しく作図して。材質は SS400。',
        en: 'Draw a new bracket. The material is SS400.',
      },
    ],
    moment: {
      ja: '仕様を伝えると図面の下書きと部品表が出て、設計者のレビュー待ちになる。',
      en: "Give a spec; out come a drawing draft and a parts list, waiting for a designer's review.",
    },
    data: {
      ja: '過去図面6枚',
      en: '6 past drawings',
    },
    seed: [{ collection: 'drawings', from: 'data/drawings' }],
    check: { tools: ['search_files', 'run_skill_script'], approval: 'Write' },
  },
  safety: ['person', 'approval', 'files'],
});
