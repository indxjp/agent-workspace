import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'market',
  title: '市場調査 / Market research',
  parts: {
    greeting: '市場の数字に、出典と時点を添えて答えます。/ I answer with sources and dates.',
    suggestedPrompts: ['2025年度の国内出荷台数は？', 'Who are the main makers?'],
    disclaimer:
      '日付つきの公開情報と調査メモだけに基づきます。予測はしません。/ Only from dated public sources and the memo; no forecasts.',
  },
});
