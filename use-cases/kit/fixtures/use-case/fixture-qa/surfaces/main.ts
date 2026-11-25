import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'fixture-qa',
  title: 'フィクスチャ',
  layout: 'side',
  parts: {
    greeting: 'マニュアルについて質問してください。',
    suggestedPrompts: ['点検の周期は？'],
  },
});
