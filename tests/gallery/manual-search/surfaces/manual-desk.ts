import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'manual-desk',
  agent: 'manual-search',
  title: 'マニュアル検索',
  layout: 'side',
  parts: {
    greeting: '設備マニュアルについて質問してください。出典つきで答えます。',
    suggestedPrompts: ['油圧ユニットの定期点検の周期は？', '作動油の交換基準を教えて'],
    disclaimer: '回答はマニュアルの記載に基づきます。作業前に原本を確認してください。',
    toolTrace: 'collapsed',
    feedback: true,
  },
});
