import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'multilingual',
  title: '多言語返信 / Multilingual replies',
  layout: 'side',
  parts: {
    greeting:
      '問い合わせの番号を教えてください。要約を付け、お客様の言語で返信の下書きを作ります。 / Give me an enquiry number: I summarize it and draft the reply in the customer’s language.',
    suggestedPrompts: [
      '問い合わせ INQ-3001 を要約して、返信の下書きを作ってください',
      'Summarize enquiry INQ-3001 and draft the reply',
      '問い合わせ INQ-3002 を要約して、担当者に回してください',
      'Summarize enquiry INQ-3002 and pass it to its owner',
    ],
    disclaimer:
      '返信は下書きです。担当者へのタスクは承認のあとに登録し、お客様には送りません。 / Replies are drafts. The task is registered only after a person approves, and nothing is sent to the customer.',
  },
});
