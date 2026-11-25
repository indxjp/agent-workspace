import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: '__slug__',
  title: '受付と振り分け / Intake and triage',
  layout: 'side',
  parts: {
    greeting: '届いた内容を振り分けます。 / I triage what arrives.',
    suggestedPrompts: [
      'これを振り分けてください',
      'Triage this, please',
      '急ぎかどうかも判断して振り分けてください',
      'Triage this and say how urgent it is',
    ],
    disclaimer: '振り分けの登録は承認のあとです。 / Nothing is routed before a person approves.',
  },
});
