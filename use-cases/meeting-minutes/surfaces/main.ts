import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'meeting-minutes',
  title: '議事録・ToDo抽出 / Meeting minutes',
  parts: {
    greeting:
      '文字起こしから議事録と、担当・期限付きのToDoを作ります。保存の前に承認をお願いします。 / I turn a transcript into minutes and to-dos with owners and dates, and ask for your approval before saving.',
    suggestedPrompts: [
      '2026-10-02_生産会議.txt の文字起こしから議事録を作成して保存してください。会議日（相対日付の基準日）: 2026-10-02',
      'Write the minutes from 2026-10-02_production-meeting.txt and save them. Meeting date (base for relative dates): 2026-10-02',
      '2026-10-05_新製品開発定例.vtt から議事録を作成して保存してください。会議日（相対日付の基準日）: 2026-10-05',
      'Write the minutes from 2026-10-05_new-product-review.vtt and save them. Meeting date (base for relative dates): 2026-10-05',
    ],
  },
});
