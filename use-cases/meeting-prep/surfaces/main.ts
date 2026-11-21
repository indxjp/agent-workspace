import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'meeting-prep',
  title: '商談準備ブリーフ / Meeting prep brief',
  layout: 'side',
  parts: {
    greeting:
      'その日の商談ごとに、取引先メモ・進行中の案件・最近のメールを1枚にまとめます。保存の前に承認をお願いします。 / For each meeting of the day, I put the account notes, open deals and recent emails on one page, and ask for your approval before saving.',
    suggestedPrompts: [
      '2026-11-24 の商談の準備ブリーフを作成して',
      'Prepare the briefs for the meetings on 2026-11-24',
      '2026-11-25 のハルカゼ製作所との商談の準備ブリーフを作成して',
      'Prepare the brief for the meeting with Harukaze Works on 2026-11-25',
    ],
  },
});
