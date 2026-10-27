import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'ringi-desk',
  agent: 'ringi-review',
  title: '稟議レビュー（決裁者向け）',
  layout: 'side',
  parts: {
    greeting:
      'レビューシートについて質問できます。規程の条文や過去の稟議を出典つきで示します。可否の判断はしません。',
    suggestedPrompts: [
      '設備投資 4,500万円の決裁区分は？',
      '相見積が1社のときに必要な記載は？',
      'フォークリフト購入で差し戻された先例はある？',
    ],
    disclaimer: 'AIによる参考情報です。決裁は職務権限規程に定める決裁者が行います。',
    toolTrace: 'collapsed',
    history: true,
    feedback: true,
  },
  // Hits render as cards. The key is the tool's bare name: a run's engine prefix is ignored.
  toolResults: { search_files: 'card' },
});
