import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'cad-drafting',
  title: '図面作成支援 / CAD drafting',
  parts: {
    greeting:
      '外形・材質・板厚・取付穴・新図番を書いてください。似た過去図面から未検図の下書き（DXF）を作ります。書き出しは承認のあとです。 / Give the outline, material, thickness, holes and new drawing number. I draft an unchecked DXF from the closest past drawing, written only after approval.',
    suggestedPrompts: [
      'ブラケット 140×90、SUS304 t2.0、φ9 の取付穴4か所（左下から 15,15 / 125,15 / 15,75 / 125,75）、新図番 BRK-1101。似た過去図面を探して作図して。',
      'Bracket 140×90, SUS304 t2.0, four φ9 holes (from the lower left: 15,15 / 125,15 / 15,75 / 125,75), new drawing BRK-1101. Find the closest past drawing and draft it.',
      'ブラケットを新しく作図して。材質は SS400。',
      'Draw a new bracket. The material is SS400.',
    ],
  },
});
