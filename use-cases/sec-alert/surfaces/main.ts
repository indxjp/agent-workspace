import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'sec-alert',
  title: 'セキュリティアラート分析 / Security alert triage',
  layout: 'side',
  parts: {
    greeting:
      'アラートの番号を教えてください。重要度を決め、調査メモを付けて当番の担当者に渡します。 / Give me an alert number: I set its severity and hand it to the on-call analyst with investigation notes.',
    suggestedPrompts: [
      'アラート SEC-0501 を分析して、担当者に渡してください',
      'Triage alert SEC-0501 and hand it to the analyst',
      'アラート SEC-0503 の重要度を決めて、調査メモを付けてください',
      'Set the severity of alert SEC-0503 and add investigation notes',
    ],
    disclaimer:
      '端末の隔離やアカウントの停止はしません。調査のタスクは承認のあとに登録します。 / Nothing is isolated or disabled. The investigation task is registered only after a person approves.',
  },
});
