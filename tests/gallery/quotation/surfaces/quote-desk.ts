import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'quote-desk',
  agent: 'quotation',
  title: '見積下書き',
  layout: 'page',
  parts: {
    // A surface takes no attachment, so the drawing itself cannot be dropped here: sales pastes
    // the spec summary the drawing gives (probe surface-attachments).
    greeting:
      '図面の要約（材質・外形・板厚・穴数・曲げ数・数量）を貼ってください。類似実績とレートから見積の下書きを作ります。',
    suggestedPrompts: [
      'SS400 t3.2 200×100 穴4×φ10 曲げ2 50個 のL形ブラケット',
      'SUS304 t2.0 300×150 穴6×φ6 曲げ4 30個 の点検カバー',
    ],
    disclaimer: '下書きです。送付・受注登録の前に、必ず承認者が確認してください。',
    toolTrace: 'collapsed',
    feedback: true,
  },
});
