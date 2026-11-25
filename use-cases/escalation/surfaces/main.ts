import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'escalation',
  title: 'エスカレーション判定 / Escalation triage',
  layout: 'side',
  parts: {
    greeting:
      'チケットの番号を教えてください。重要度を決め、開発部や責任者を呼ぶべきかを判定します。 / Give me a ticket number: I set its priority and decide whether engineering or a manager is needed.',
    suggestedPrompts: [
      'チケット TCK-2101 のエスカレーションを判定してください',
      'Decide whether ticket TCK-2101 needs escalating',
      'チケット TCK-2103 を判定して、呼ぶ相手を決めてください',
      'Triage ticket TCK-2103 and decide whom to pull in',
    ],
    disclaimer:
      'エスカレーションのタスクは、承認のあとに登録します。お客様への返信は送りません。 / The escalation task is registered only after a person approves. No reply is sent to the customer.',
  },
});
