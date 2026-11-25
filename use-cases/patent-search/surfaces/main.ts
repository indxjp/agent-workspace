import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'patent-search',
  title: '特許調査 / Patent search',
  parts: {
    greeting: '技術メモに近い先行特許を探して比べます。/ I find and compare prior patents.',
    suggestedPrompts: ['部品反転装置のメモに近い特許は？', 'Patents filed by Hakuseki Kogyo?'],
    disclaimer:
      '日付つきの特許公報だけに基づきます。特許性の判断は弁理士が行います。/ Only from dated publications; a patent attorney judges patentability.',
  },
});
