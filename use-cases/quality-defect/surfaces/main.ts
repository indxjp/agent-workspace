import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'quality-defect',
  title: '品質不良・過去トラブル分析 / Quality defect analysis',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '新しい不良の現象・品番・ロット・工程・発生数を入力してください。似た過去トラブルと当時の対策を挙げ、原因候補を件数順に示します。 / Enter the new defect: symptom, part, lot, process and count. I list similar past incidents and their fixes, and the likely causes ranked by count.',
    suggestedPrompts: [
      '現象: バリ／品番: BRK-2201／ロット: L260928-2／工程: プレス／発生数: 48',
      'Symptom: burr / Part: BRK-2201 / Lot: L260928-2 / Process: press / Count: 48',
      '現象: 塗装ムラ／品番: CVR-5120／ロット: L260930-1／工程: 塗装／発生数: 120',
      'Symptom: uneven paint / Part: CVR-5120 / Lot: L260930-1 / Process: painting / Count: 120',
    ],
    disclaimer:
      '原因候補は過去の報告の件数順です。原因と対策は担当者が判断します。 / Causes are ranked by past reports; a person decides.',
    toolTrace: 'collapsed',
    history: true,
  },
});
