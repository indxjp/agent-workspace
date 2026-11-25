import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'incident',
  title: '障害一次対応 / Incident triage',
  layout: 'side',
  parts: {
    greeting:
      'アラートの番号を教えてください。重要度と担当者を決め、最初の連絡文を下書きします。 / Give me an alert number: I set its severity, pick the on-call owner and draft the first update.',
    suggestedPrompts: [
      'アラート ALT-0042 を一次対応してください',
      'Triage alert ALT-0044 and pick the on-call owner',
    ],
    disclaimer:
      '担当者への振り分けは、承認のあとに登録します。コマンドは実行しません。 / The routing is registered only after a person approves. No command is run.',
  },
});
