import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'quality-defect',
  area: 'mfg',
  status: 'live',
  wave: 1,
  kind: 'agent',
  source: 'tests/gallery/quality-defect',
  name: {
    ja: '品質不良・過去トラブル分析',
    en: 'Quality defect analysis',
  },
  summary: {
    ja: '不良報告から似た過去のトラブルと対策を探し、原因の候補を挙げる。',
    en: 'Finds similar past incidents and fixes for a defect report and lists likely causes.',
  },
  demo: {
    agent: 'quality-defect',
    prompts: [
      {
        ja: '現象: バリ／品番: BRK-2201／ロット: L260928-2／工程: プレス／発生数: 48',
        en: 'Symptom: burr / Part: BRK-2201 / Lot: L260928-2 / Process: press / Count: 48',
      },
      {
        ja: '現象: 塗装ムラ／品番: CVR-5120／ロット: L260930-1／工程: 塗装／発生数: 120',
        en: 'Symptom: uneven paint / Part: CVR-5120 / Lot: L260930-1 / Process: painting / Count: 120',
      },
    ],
    moment: {
      ja: '不良報告を入れると、似た過去トラブルと当時の対策が並び、原因候補が順位付きで出る。',
      en: 'Enter a defect; similar past incidents and their fixes appear, with ranked likely causes.',
    },
    data: {
      ja: 'FMEAシート1冊',
      en: '1 FMEA workbook',
    },
    seed: [{ collection: 'fmea', from: 'data/fmea' }],
    check: { tools: ['searchDefects', 'getDefect', 'causeStats'], approval: null },
  },
  safety: ['person', 'structured'],
  next: {
    source: 'use-cases/quality-defect',
    demo: {
      agent: 'quality-defect',
      prompts: [
        {
          ja: '現象: バリ／品番: BRK-2201／ロット: L260928-2／工程: プレス／発生数: 48',
          en: 'Symptom: burr / Part: BRK-2201 / Lot: L260928-2 / Process: press / Count: 48',
        },
        {
          ja: '現象: 塗装ムラ／品番: CVR-5120／ロット: L260930-1／工程: 塗装／発生数: 120',
          en: 'Symptom: uneven paint / Part: CVR-5120 / Lot: L260930-1 / Process: painting / Count: 120',
        },
      ],
      moment: {
        ja: '不良報告を入れると、似た過去トラブルと当時の対策が並び、原因候補が件数順に出る。',
        en: 'Enter a defect; similar past incidents and their fixes appear, with likely causes ranked by count.',
      },
      data: {
        ja: '架空のQMSの不具合報告20件（CSV）とプレス工程FMEA（Excel）',
        en: '20 fictional QMS defect reports (CSV) and a press process FMEA (Excel)',
      },
      seed: [{ collection: 'quality-defect', from: 'data' }],
      check: { tools: ['search_files', 'run_skill_script'], approval: null },
    },
  },
});
