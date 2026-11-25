import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'work-instruction',
  title: '作業手順書作成 / Work instruction writer',
  layout: 'page',
  parts: {
    greeting:
      '現場での説明の文字起こしから、安全基準の条項を添えた作業手順書の下書きを Word で作ります。書き出す前に承認をお願いします。 / From a transcript of a walkthrough on the floor, I draft a work instruction as a Word document, with safety notes cited from your safety standard, and ask for your approval before writing it.',
    suggestedPrompts: [
      'P-3 の金型交換の文字起こしから作業手順書を作成して',
      'Draft the work instruction for the P-3 die change from the transcript',
      'P-3 の金型交換の作業手順書の構成だけを示して',
    ],
    disclaimer:
      '下書きです。手順と安全上の注意は監督者が確認してから発行します。 / A draft: a supervisor checks the steps and safety notes before issuing it.',
    toolTrace: 'collapsed',
    history: true,
  },
});
