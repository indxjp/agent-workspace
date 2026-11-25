import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'customer-inquiry',
  title: 'お客様問い合わせ / Customer enquiries',
  layout: 'side',
  parts: {
    greeting:
      'お客様の問い合わせを貼るか、番号を教えてください。FAQ にもとづく返信の下書きを作り、担当者に回します。 / Paste an enquiry or give its number: I draft a reply from the FAQ and route it to the owner.',
    suggestedPrompts: [
      '商品が届いてから何日以内なら返品できますか？',
      'How many days after delivery can I still return an item?',
      '先週返品した商品の代金をすぐ返金してください',
      'Please refund the item I returned last week right away.',
    ],
    disclaimer:
      '返信は下書きです。担当者へのタスクは承認のあとに登録し、お客様には送りません。返金は担当者が決めます。 / Replies are drafts. The task is registered only after a person approves, nothing is sent to the customer, and refunds are the owner’s decision.',
  },
});
