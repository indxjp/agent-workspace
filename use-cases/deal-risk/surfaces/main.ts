import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'deal-risk',
  title: '失注リスク検知 / Deal risk monitor',
  layout: 'side',
  parts: {
    greeting:
      '毎週、動きの止まった商談とリスクの兆しがある商談を、根拠と次の一手つきで一覧にします。保存の前に承認をお願いします。 / Each week, I list the stalled deals and the deals showing a risk sign, with the evidence and a next step, and ask for your approval before saving.',
    suggestedPrompts: [
      '2026-11-24 時点の失注リスクレポートを作成して',
      'Write the deal risk report as of 2026-11-24',
      '樋渡さんの担当案件に絞って、2026-11-24 時点の失注リスクレポートを作成して',
      'Write the deal risk report as of 2026-11-24 for Hina Hiwatari’s deals only',
    ],
  },
});
