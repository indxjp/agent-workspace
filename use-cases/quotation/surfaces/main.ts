import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'quotation',
  title: '見積作成 / Quotation',
  parts: {
    greeting:
      '部品の仕様と数量を書いてください。過去の受注と単価表から見積の下書きを作ります。ERPへの登録は承認のあとです。 / Give the part spec and quantity. I draft the quote from past orders and the rate table; registering it in the ERP waits for approval.',
    suggestedPrompts: [
      'サンプル精機株式会社、図番 SMP-M-2231 rev.B の L形ブラケット（SS400、200×100×t3.2、φ10の穴4か所、曲げ2）50個の見積を作り、ERPに登録して',
      'Quote 50 L brackets for Sample Seiki Co., drawing SMP-M-2231 rev.B (SS400, 200×100×t3.2, four φ10 holes, 2 bends), and register it in the ERP',
      'サンプル中央工業株式会社、図番 SMP-H-0042 の放熱プレート（A5052、120×80×t5、φ5.5の穴4か所、曲げなし）7個の見積を作って（登録はしないで）',
      'Quote 7 heat-sink plates for Sample Chuo Industries Co., drawing SMP-H-0042 (A5052, 120×80×t5, four φ5.5 holes, no bends); do not register it',
    ],
  },
});
