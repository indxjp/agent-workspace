import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'quote-desk',
  agent: 'quotation',
  title: '見積下書き',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '図面（PDF または画像）を添付し、顧客名と数量を入力してください。図面から仕様を読み取り、類似実績とレートから見積の下書きを作ります。',
    suggestedPrompts: [
      '東和機工株式会社 50個 添付の図面で見積をお願いします',
      '株式会社さくら電子 30個 添付の図面で見積をお願いします',
    ],
    disclaimer: '下書きです。送付・受注登録の前に、必ず承認者が確認してください。',
    toolTrace: 'collapsed',
    feedback: true,
  },
});
