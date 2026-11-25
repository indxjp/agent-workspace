import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'voc',
  title: 'お客様の声分析 / Voice of the customer',
  layout: 'side',
  parts: {
    greeting:
      'その月のお問い合わせとレビューを改善テーマにまとめます。お客様の連絡先は書きません。 / I group the month’s enquiries and reviews into improvement themes, without customers’ contact details.',
    suggestedPrompts: [
      '2026年10月のお客様の声レポートを作成して',
      'Write the voice-of-the-customer report for October 2026',
      '2026年10月の声のうち、電気ケトル KT-20 についてのものだけをまとめて',
      'Summarise only the October 2026 voices about the Electric kettle KT-20',
    ],
  },
});
