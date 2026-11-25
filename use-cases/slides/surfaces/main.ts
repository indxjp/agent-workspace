import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'slides',
  title: '資料ドラフト / Slide drafter',
  layout: 'page',
  parts: {
    greeting:
      '要点メモから、社内のスライドの書き方に沿って PowerPoint の下書きを作ります。数字と予定は資料から写し、出典を添えます。書き出す前に承認をお願いします。 / From your bullet notes, I draft a PowerPoint deck that follows your slide guide, with figures and dates copied from the sources and cited. I ask for your approval before writing it.',
    suggestedPrompts: [
      'ヘルプデスク刷新の要点メモから、部門長会議のスライドを作成して',
      "Draft the department heads' meeting deck from the help desk renewal notes",
      'ヘルプデスク刷新の中間報告のスライド構成だけを示して',
      'Show only the slide outline of the help desk renewal interim report',
    ],
    disclaimer:
      '下書きです。内容は作成者が確認してから発表します。 / A draft: the presenter checks it before the talk.',
    toolTrace: 'collapsed',
    history: true,
  },
});
