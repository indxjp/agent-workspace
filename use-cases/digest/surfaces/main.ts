import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'digest',
  title: '調査ダイジェスト / Research digest',
  layout: 'side',
  parts: {
    greeting:
      '1週間分の社内メモと公開情報を、日付と出典つきで1つのダイジェストにまとめます。保存の前に承認をお願いします。 / I gather a week of internal notes and public releases into one digest, with dates and sources, and ask for your approval before saving.',
    suggestedPrompts: [
      '2026-11-24 までの1週間の調査ダイジェストを作成して',
      'Write the research digest for the week up to 2026-11-24',
      '2026-11-17 までの1週間の調査ダイジェストを作成して',
      'Write the research digest for the week up to 2026-11-17',
    ],
  },
});
