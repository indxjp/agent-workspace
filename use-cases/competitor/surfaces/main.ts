import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'competitor',
  title: '競合比較シート / Competitor brief',
  layout: 'side',
  parts: {
    greeting:
      '毎週、競合の公開情報と比較表を突き合わせ、変わった行を根拠と公表日つきで一覧にします。保存の前に承認をお願いします。 / Each week, I check your comparison table against competitors’ public releases and list the rows that changed, with the source and date, and ask for your approval before saving.',
    suggestedPrompts: [
      '2026-11-23 時点の競合比較レポートを作成して',
      'Write the competitor comparison report as of 2026-11-23',
      'ツユクサ・ラボに絞って、2026-11-23 時点の競合比較レポートを作成して',
      'Write the competitor comparison report as of 2026-11-23 for Tsuyukusa Labs only',
    ],
  },
});
