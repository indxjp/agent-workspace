import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'design-desk',
  agent: 'cad-drafting',
  title: '図面流用デスク',
  layout: 'page',
  parts: {
    greeting:
      '新しい部品の要件（外形の幅×高さ、材質・板厚、取付穴、新図番）を書いてください。似た過去図面を3件探します。参考図（DXF）があれば添付してください。',
    suggestedPrompts: [
      'ブラケット 140×90、SUS304 t2.0、φ9 の取付穴4か所、新図番 BRK-1101',
      'SS400 t3.2 で 120×60 前後のブラケットを探して',
    ],
    disclaimer: '作図結果は未検図の下書きです。出図前に必ず設計者が検図してください。',
    toolTrace: 'collapsed',
    attachments: true,
    history: true,
    feedback: true,
  },
});
