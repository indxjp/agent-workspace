import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'legal-intake',
  title: '法務相談受付 / Legal intake',
  layout: 'side',
  parts: {
    greeting:
      '受付番号を教えてください。相談を分類し、資料をそろえて法務の担当者に渡します。 / Give me a request number: I sort it, gather its documents and hand it to a lawyer.',
    suggestedPrompts: [
      '法務相談 LGL-0101 を受け付けて、担当者に渡してください',
      'Take in legal request LGL-0101 and hand it to a lawyer',
      '法務相談 LGL-0102 を受け付けて、足りない資料も挙げてください',
      'Take in legal request LGL-0102 and list the missing documents',
    ],
    disclaimer:
      '法的な助言はしません。担当者へのタスクは承認のあとに登録します。 / No legal advice is given. The task is registered only after a person approves.',
  },
});
